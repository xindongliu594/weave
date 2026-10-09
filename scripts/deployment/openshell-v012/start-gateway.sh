#!/usr/bin/env bash
# REVIEWABLE DRAFT. Default --check is read-only and requires no Docker socket.
# --apply is a FIRST installation only, requiring local administrator approval.
set -Eeuo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
export LC_ALL=C
umask 077
mode="${1:---check}"
[[ $# -le 1 && ( "$mode" == --check || "$mode" == --apply ) ]] || {
  printf 'Usage: bash start-gateway.sh [--check|--apply]\n' >&2; exit 2;
}
die() { printf 'STOP: %s\n' "$*" >&2; exit 1; }
# Explicit local daemon; do not use another saved context or inherited remote TLS.
# This changes only this command's environment, never Docker's config files.
docker_local() {
  env -u DOCKER_CONTEXT -u DOCKER_HOST -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH \
    docker --host unix:///var/run/docker.sock "$@"
}
draft_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
state=/var/lib/weiwu-openshell-v012
client_user=jj
gateway_image=ghcr.io/nvidia/openshell/gateway:0.1.2@sha256:2fe4dad9118e14ab80a8258b545ea6e6cd74c3469e24ad4e6610f964d98913a2
[[ -f "$draft_dir/compose.yaml" && -f "$draft_dir/gateway.toml" ]] || die 'Missing reviewed configuration files.'
docker_local compose --env-file /dev/null -f "$draft_dir/compose.yaml" config --quiet
docker_local compose --env-file /dev/null -f "$draft_dir/compose.yaml" config --format json | python3 -c '
import json, sys
gateway = json.load(sys.stdin)["services"]["gateway"]
assert gateway["command"] == ["--bind-address", "0.0.0.0", "--port", "18770"]
assert gateway["ports"][0]["host_ip"] == "127.0.0.1"
print("Explicit gateway command and host loopback publication checked.")
'
python3 - "$draft_dir/gateway.toml" "$draft_dir/verified-images.json" <<'PY'
import json, sys, tomllib
with open(sys.argv[1], 'rb') as source: config = tomllib.load(source)['openshell']
with open(sys.argv[2]) as source: images = json.load(source)['images']
gateway = config['gateway']; driver = config['drivers']['docker']
assert config['version'] == 2
assert gateway['bind_address'] == '0.0.0.0:18770'
assert gateway['health_bind_address'] == '0.0.0.0:18771'
assert gateway['disable_tls'] is False
assert gateway['auth']['allow_unauthenticated_users'] is False
assert gateway['mtls_auth']['enabled'] is True
assert gateway['tls']['client_ca_path'].endswith('/tls/ca.crt')
assert driver['sandbox_runtime_image'] == images['sandbox']
assert driver['supervisor_image'] == images['supervisor']
assert driver['enable_bind_mounts'] is False
print('Compose syntax and selected TOML safety checks passed (not OpenShell binary preflight).')
PY
if [[ "$mode" == --check ]]; then
  printf '%s\n' 'No containers, files, services, groups or permissions changed.'
  exit 0
fi
(( EUID == 0 )) || die 'Apply requires local sudo authentication; no password is requested by this script.'
# shellcheck disable=SC1091
. /etc/os-release
[[ "${ID:-}" == ubuntu && "${VERSION_ID:-}" == 26.04 && "$(dpkg --print-architecture)" == amd64 ]] || die 'Expected jj Ubuntu 26.04 amd64.'
[[ ! -e "$state" && ! -L "$state" ]] || die 'State already exists; preserve it and review before retrying. No automatic reset/renewal.'
client_home=/home/jj/.local/share/weiwu/home
client_uid="$(id -u "$client_user")"
[[ -d "$client_home" && ! -L "$client_home" ]] || die 'Expected existing Weiwu private HOME directory.'
[[ "$(stat -c '%u' "$client_home")" == "$client_uid" ]] || die 'Weiwu private HOME must belong to jj.'
[[ "$(readlink -f -- "$client_home")" == "$client_home" ]] || die 'Weiwu private HOME ancestor is a symlink; preserve and review.'
bundle="$client_home/.config/openshell/gateways/weiwu-openshell-v012/mtls"
for parent in "$client_home/.config" "$client_home/.config/openshell" "$client_home/.config/openshell/gateways"; do
  [[ ! -L "$parent" ]] || die 'CLI certificate parent is a symlink; preserve it and review the path.'
  [[ ! -e "$parent" || -d "$parent" ]] || die 'CLI certificate parent is not a directory.'
done
[[ ! -e "$client_home/.config/openshell/gateways/weiwu-openshell-v012" && ! -L "$client_home/.config/openshell/gateways/weiwu-openshell-v012" ]] || die 'CLI gateway entry already exists; do not overwrite.'
[[ -S /var/run/docker.sock ]] || die 'Docker socket unavailable.'
if [[ -n "$(ss -H -ltn '( sport = :18770 or sport = :18771 )')" ]]; then
  die 'Proposed ports are occupied; no existing listener is stopped.'
fi
docker_local info --format '{{.ServerVersion}}'
printf '%s\n' 'Explicit administrator actions: pull three pinned images; create new private state/PKI; provision jj client bundle; start only the named Compose gateway.'
mapfile -t images < <(python3 - "$draft_dir/verified-images.json" <<'PY'
import json, sys
with open(sys.argv[1]) as source:
    for image in json.load(source)['images'].values(): print(image)
PY
)
for image in "${images[@]}"; do docker_local pull --platform linux/amd64 "$image"; done
# Preserve all existing root directories and Docker daemon/proxy configuration.
mkdir -- "$state"
chmod 0700 "$state"
install -m 0600 "$draft_dir/compose.yaml" "$state/compose.yaml"
install -m 0600 "$draft_dir/gateway.toml" "$state/gateway.toml"
install -m 0600 "$draft_dir/verified-images.json" "$state/verified-images.json"

# Official certgen local mode; no socket, network, --dry-run or printed private keys.
# Its automatic CLI copy stays in this NEW root-owned tree, not /root/.config.
docker_local run --rm --pull never --network none --user 0 \
  --cap-drop ALL --security-opt no-new-privileges \
  --mount "type=bind,src=$state,dst=$state" \
  -e "HOME=$state" -e "XDG_CONFIG_HOME=$state/bootstrap-config" \
  "$gateway_image" generate-certs --output-dir "$state/tls" \
  --server-san localhost --server-san 127.0.0.1 --server-san ::1 \
  --server-san host.openshell.internal

# Actual OpenShell schema preflight, still without Docker socket/network.
docker_local run --rm --pull never --network none --user 0 \
  --cap-drop ALL --security-opt no-new-privileges \
  --mount "type=bind,src=$state,dst=$state" \
  -e "HOME=$state" -e "XDG_CONFIG_HOME=$state/config" \
  "$gateway_image" config preflight --path "$state/gateway.toml"

# Create only the new gateway subtree as jj; writes execute with jj's permissions.
# The trusted CLI key is local gateway authority, never an employee attachment.
runuser -u "$client_user" -- sh -c '
  set -eu; umask 077
  for parent in "$2/.config" "$2/.config/openshell" "$2/.config/openshell/gateways"; do
    test ! -L "$parent" || exit 1
    test ! -e "$parent" || test -d "$parent" || exit 1
  done
  test ! -e "$1" && test ! -L "$1"
  mkdir -p -- "$1"
  test "$(readlink -f -- "$1")" = "$1"
' sh "$bundle" "$client_home"
for entry in ca.crt client/tls.crt client/tls.key; do
  destination="${entry##*/}"
  cat -- "$state/tls/$entry" | runuser -u "$client_user" -- sh -c \
    'umask 077; set -C; cat > "$1"' sh "$bundle/$destination"
done
docker_local compose --env-file /dev/null -f "$state/compose.yaml" up --detach --pull never
printf '%s\n' 'Gateway started; runtime authentication and sandbox verification still required.'
printf '%s\n' 'As jj (not sudo), register using the already-installed private CLI:'
printf '%s\n' 'env HOME=/home/jj/.local/share/weiwu/home XDG_CONFIG_HOME=/home/jj/.local/share/weiwu/home/.config /home/jj/.local/share/weiwu/runtime/openshell-v0.1.2/openshell gateway add https://127.0.0.1:18770 --local --name weiwu-openshell-v012'
printf '%s\n' 'env HOME=/home/jj/.local/share/weiwu/home XDG_CONFIG_HOME=/home/jj/.local/share/weiwu/home/.config /home/jj/.local/share/weiwu/runtime/openshell-v0.1.2/openshell status -g weiwu-openshell-v012 --output json'
printf '%s\n' 'Require Connected AND Authenticated. No model/provider/employee sandbox was created.'

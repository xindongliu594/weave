#!/usr/bin/env bash
# REVIEWABLE DRAFT: run on jj only after reviewing, using local sudo authentication.
# Source: https://docs.docker.com/engine/install/ubuntu/ (checked 2026-10-08).
# No company credentials, Node installation, Docker-group membership, application
# deployment, firewall commands, suspend changes, package removal, or data pruning.
# Installing packages registers system units and may enable them through package
# scripts. A temporary policy-rc.d prevents automatic service starts/restarts;
# --start-docker is the explicit opt-in to start Docker (including its dependencies).
# Starting Docker itself can create its normal bridge/iptables rules.
set -Eeuo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
export LC_ALL=C
umask 077

install_requested=0
start_requested=0
hello_requested=0
for argument in "$@"; do
  case "$argument" in
    --check) ;;
    --install) install_requested=1 ;;
    --start-docker) start_requested=1 ;;
    --hello-world) hello_requested=1 ;;
    --help)
      printf '%s\n' \
        'Usage: bash prepare-jj-docker.sh [--check]' \
        '       sudo bash prepare-jj-docker.sh --install [--start-docker] [--hello-world]' \
        'Default: read-only checks; --install: add missing official packages/repository.' \
        '--start-docker: systemctl start docker; no restart/enable command.' \
        '--hello-world: download and run the official test image; implies --start-docker.'
      exit 0 ;;
    *) printf 'Unknown option: %s\n' "$argument" >&2; exit 2 ;;
  esac
done
if (( hello_requested )); then start_requested=1; fi
if (( start_requested && !install_requested )); then
  printf '%s\n' 'Service/image actions require --install.' >&2; exit 2
fi
die() { printf 'STOP: %s\n' "$*" >&2; exit 1; }
[[ -r /etc/os-release ]] || die '/etc/os-release is unavailable.'
# shellcheck disable=SC1091
. /etc/os-release
[[ "${ID:-}" == ubuntu && "${VERSION_ID:-}" == 26.04 ]] || die 'Only Ubuntu 26.04 is accepted.'
codename="${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}"
[[ "$codename" == resolute ]] || die 'Expected Ubuntu codename resolute.'
[[ "$(uname -m)" == x86_64 && "$(dpkg --print-architecture)" == amd64 ]] || die 'Only x86_64/amd64 is accepted.'
if (( install_requested )); then
  (( EUID == 0 )) || die 'Use local sudo authentication; this script does not obtain a password.'
fi
installed() { [[ "$(dpkg-query -W -f='${Status}' "$1" 2>/dev/null || true)" == 'install ok installed' ]]; }
packages=(docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin tmux)
printf 'Host: %s; OS: Ubuntu %s (%s); architecture: amd64\n' "$(hostname)" "$VERSION_ID" "$codename"
printf '%s\n' 'Existing packages (kept at their installed versions):'
for package in "${packages[@]}" ca-certificates curl; do
  if installed "$package"; then dpkg-query -W -f='${Package}\t${Version}\n' "$package"; fi
done
printf '%s\n' 'Current TCP listeners (no ports are stopped, reserved, or published):'
if command -v ss >/dev/null; then ss -H -ltn; else printf 'ss unavailable\n'; fi
conflicts=()
for package in docker.io docker-compose docker-compose-v2 docker-doc docker-buildx podman-docker containerd runc; do
  if installed "$package"; then conflicts+=("$package"); fi
done
if (( ${#conflicts[@]} )); then
  printf 'Conflicting installed packages: %s\n' "${conflicts[*]}"
  die 'Nothing is removed. Review the existing installation separately.'
fi
repo=/etc/apt/sources.list.d/docker.sources
key=/etc/apt/keyrings/docker.asc
expected_repo="$(printf '%s\n' 'Types: deb' 'URIs: https://download.docker.com/linux/ubuntu' \
  'Suites: resolute' 'Components: stable' 'Architectures: amd64' 'Signed-By: /etc/apt/keyrings/docker.asc')"
for path in /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources; do
  [[ -f "$path" ]] || continue
  if grep -q 'download\.docker\.com' "$path" && [[ "$path" != "$repo" ]]; then
    die "Existing Docker source $path is preserved; reconcile it manually before this script."
  fi
done
if [[ -e "$repo" || -L "$repo" ]]; then
  [[ -f "$repo" && ! -L "$repo" ]] || die 'Existing docker.sources is not a regular file.'
  [[ "$(cat "$repo")" == "$expected_repo" ]] || die 'Existing docker.sources differs; it is not overwritten.'
fi
if [[ -e "$key" || -L "$key" ]]; then
  [[ -f "$key" && ! -L "$key" ]] || die 'Existing Docker key is not a regular file.'
fi
if (( !install_requested )); then
  printf '%s\n' 'Check complete; no changes made. Run --install only after reviewing this script.'
  exit 0
fi

log_file="$(mktemp /var/tmp/prepare-jj-docker-XXXXXXXX.log)"
exec > >(tee -a "$log_file") 2>&1
printf 'Installation/version record: %s\n' "$log_file"
printf '%s\n' 'APT package scripts may register/enable system units. Automatic starts/restarts will be suppressed.'
temporary_dir="$(mktemp -d /var/tmp/prepare-jj-docker-XXXXXXXX)"
policy_created=0
cleanup() {
  local status=$?
  if (( policy_created )); then
    if cmp -s /usr/sbin/policy-rc.d "$temporary_dir/policy-rc.d"; then
      rm -- /usr/sbin/policy-rc.d
    else
      printf '%s\n' 'policy-rc.d changed concurrently; preserved for manual review.' >&2
    fi
  fi
  rm -rf -- "$temporary_dir"
  printf 'Finished with exit %s; record: %s\n' "$status" "$log_file"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
[[ ! -e /usr/sbin/policy-rc.d && ! -L /usr/sbin/policy-rc.d ]] || die 'Existing policy-rc.d is preserved; service policy requires separate review.'
printf '#!/bin/sh\n# Temporary prepare-jj-docker service-start guard\nexit 101\n' > "$temporary_dir/policy-rc.d"
# noclobber prevents replacing a file created concurrently.
( set -o noclobber; cat "$temporary_dir/policy-rc.d" > /usr/sbin/policy-rc.d )
policy_created=1
chmod 0755 /usr/sbin/policy-rc.d

install_missing() {
  local package candidate
  local -a selected=()
  for package in "$@"; do
    if installed "$package"; then continue; fi
    candidate="$(apt-cache policy "$package" | awk '/Candidate:/ {print $2; exit}')"
    [[ -n "$candidate" && "$candidate" != '(none)' ]] || die "No APT candidate for $package."
    selected+=("$package=$candidate")
  done
  (( ${#selected[@]} )) || return 0
  printf 'Proposed exact new package versions: %s\n' "${selected[*]}"
  apt-get --simulate --no-remove --no-upgrade --no-install-recommends install "${selected[@]}" > "$temporary_dir/apt-plan.txt"
  cat "$temporary_dir/apt-plan.txt"
  # Refuse removals or upgrades of *any* existing dependency, not just the six targets.
  if grep -Eq '^Remv |^Inst [^ ]+ \[' "$temporary_dir/apt-plan.txt"; then
    die 'APT would remove/upgrade an existing package; no install is performed.'
  fi
  DEBIAN_FRONTEND=noninteractive apt-get -y --no-remove --no-upgrade --no-install-recommends install "${selected[@]}"
}
apt-get update
install_missing ca-certificates curl
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
  https://download.docker.com/linux/ubuntu/gpg -o "$temporary_dir/docker.asc"
grep -q '^-----BEGIN PGP PUBLIC KEY BLOCK-----' "$temporary_dir/docker.asc" || die 'Docker key response is not an ASCII-armored public key.'
if [[ -e "$key" ]]; then
  cmp -s "$key" "$temporary_dir/docker.asc" || die 'Existing Docker key differs from the official response; preserved.'
else
  install -d -m 0755 /etc/apt/keyrings
  ( set -o noclobber; cat "$temporary_dir/docker.asc" > "$key" )
  chmod 0644 "$key"
fi
if [[ ! -e "$repo" ]]; then
  ( set -o noclobber; printf '%s\n' "$expected_repo" > "$repo" )
  chmod 0644 "$repo"
fi
printf '%s\n' 'Official repository/key SHA256:'
sha256sum "$repo" "$key"
apt-get update
install_missing "${packages[@]}"
printf '%s\n' 'Installed versions:'
dpkg-query -W -f='${Package}\t${Version}\n' "${packages[@]}" ca-certificates curl
docker --version
docker buildx version
docker compose version
tmux -V

# Remove only our temporary guard before the explicitly requested service action.
cmp -s /usr/sbin/policy-rc.d "$temporary_dir/policy-rc.d" || die 'Service guard changed; do not start Docker.'
rm -- /usr/sbin/policy-rc.d
policy_created=0
if (( start_requested )); then
  printf '%s\n' 'Explicit system-service action: systemctl start docker (no restart/enable command).'
  systemctl start docker
  systemctl is-active docker
  docker version
else
  printf '%s\n' 'Docker is not started by this script; existing running services were not stopped.'
fi
if (( hello_requested )); then
  printf '%s\n' 'Explicit verification: download/run official hello-world; no published ports or socket mount.'
  # Removes only this new throwaway test container; keeps its downloaded image.
  docker run --rm --network none hello-world
  docker image inspect hello-world --format '{{json .RepoDigests}}'
fi
printf '%s\n' 'No user was added to the docker group; do not grant employees the Docker socket.'

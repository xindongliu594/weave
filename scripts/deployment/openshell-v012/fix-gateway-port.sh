#!/usr/bin/env bash
# Default --check is read-only. --apply repairs only the owned Compose command.
set -Eeuo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
export LC_ALL=C
umask 077
mode="${1:---check}"
[[ $# -le 1 && ( "$mode" == --check || "$mode" == --apply ) ]] || {
  printf 'Usage: bash fix-gateway-port.sh [--check|--apply]\n' >&2; exit 2;
}
draft_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
python3 - "$mode" "$draft_dir/compose.yaml" <<'PY'
import datetime, hashlib, json, os, pathlib, subprocess, sys, tempfile
mode, draft = sys.argv[1], pathlib.Path(sys.argv[2])
state = pathlib.Path('/var/lib/weiwu-openshell-v012')
owned = state / 'compose.yaml'
old_sha = 'a10c59aa4721ad614ae4e3a8ac339ce26386b316e00d0f1301d9b25ce9abf3f6'
image = 'ghcr.io/nvidia/openshell/gateway:0.1.2@sha256:2fe4dad9118e14ab80a8258b545ea6e6cd74c3469e24ad4e6610f964d98913a2'
command = ['--bind-address', '0.0.0.0', '--port', '18770']
old_line = b'    command: []'
new_line = b'    command: ["--bind-address", "0.0.0.0", "--port", "18770"]'
env = dict(os.environ)
for key in ('DOCKER_CONTEXT', 'DOCKER_HOST', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'):
    env.pop(key, None)
docker = ['docker', '--host', 'unix:///var/run/docker.sock']
def run(args):
    return subprocess.run(docker + args, env=env, check=True, text=True,
                          stdout=subprocess.PIPE).stdout
def stop(message):
    raise SystemExit('STOP: ' + message)
def compose(path, *args):
    return run(['compose', '--env-file', '/dev/null', '-f', str(path), *args])
def verify_config(path):
    config = json.loads(compose(path, 'config', '--format', 'json'))
    if config.get('name') != 'weiwu-openshell-v012': stop('Unexpected Compose project.')
    gateway = config['services']['gateway']
    if gateway['image'] != image or gateway['command'] != command:
        stop('Expected pinned image and explicit 18770 command.')
    ports = {(p['host_ip'], str(p['published']), p['target']) for p in gateway['ports']}
    if ports != {('127.0.0.1', '18770', 18770), ('127.0.0.1', '18771', 18771)}:
        stop('Expected only the two existing host loopback publications.')
verify_config(draft)
draft_bytes = draft.read_bytes()
if draft_bytes.count(new_line) != 1 or old_line in draft_bytes:
    stop('Unexpected reviewed command declaration.')
if mode == '--check':
    print('Read-only Compose check passed: fixed image, explicit port 18770, host loopback.')
    print('Apply requires the exact deployed original SHA and actual container Args on 8080.')
    print('No daemon access, files, containers, credentials or services changed.')
    raise SystemExit(0)
if os.geteuid() != 0: stop('Apply requires local sudo authentication.')
if not state.is_dir() or state.is_symlink() or state.resolve() != state:
    stop('Expected canonical existing owned state directory.')
if state.stat().st_uid != 0: stop('State is not owned by root.')
if not owned.is_file() or owned.is_symlink() or owned.stat().st_uid != 0:
    stop('Expected root-owned regular Compose file.')
old = owned.read_bytes()
if hashlib.sha256(old).hexdigest() != old_sha:
    stop('Deployed Compose differs from the reviewed original; preserve and review.')
if old.count(old_line) != 1: stop('Original command is not unique.')
patched = old.replace(old_line, new_line, 1)
if patched != draft_bytes: stop('Reviewed draft contains changes beyond the exact command patch.')
container_ids = compose(owned, 'ps', '--quiet', 'gateway').split()
if len(container_ids) != 1: stop('Expected exactly one current gateway container.')
# Deliberately omit Config.Env, mounts and all other inspection fields.
fmt = '{"Path":{{json .Path}},"Args":{{json .Args}},"State":{{json .State}},"PortBindings":{{json .HostConfig.PortBindings}},"Image":{{json .Config.Image}}}'
inspection = json.loads(run(['inspect', '--format', fmt, container_ids[0]]))
if inspection['Image'] != image or inspection['Path'] != '/usr/local/bin/openshell-gateway':
    stop('Actual gateway image/entrypoint is not the reviewed deployment.')
if inspection['Args'] != ['--bind-address', '0.0.0.0', '--port', '8080']:
    stop('Actual Args do not prove the known 8080 mismatch; do not guess a repair.')
if not inspection['State'].get('Running'): stop('Current gateway is not running.')
expected_ports = {'18770/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '18770'}],
                  '18771/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '18771'}]}
if inspection['PortBindings'] != expected_ports:
    stop('Current port bindings differ from the reviewed deployment.')
backup = state / ('port-fix-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ'))
backup.mkdir(mode=0o700)  # Fail if a collision exists; never overwrite evidence.
def exclusive_write(path, data):
    with open(path, 'xb') as file:
        file.write(data); file.flush(); os.fsync(file.fileno())
    os.chmod(path, 0o600)
exclusive_write(backup / 'compose.original.yaml', old)
exclusive_write(backup / 'gateway-before.json', (json.dumps(inspection, indent=2)+'\n').encode())
with tempfile.NamedTemporaryFile(prefix='.compose-port-', suffix='.yaml', dir=state, delete=False) as file:
    candidate = pathlib.Path(file.name)
    file.write(patched); file.flush(); os.fsync(file.fileno())
try:
    os.chmod(candidate, 0o600)
    verify_config(candidate)
    # Recheck immediately before replacement; do not overwrite a concurrent edit.
    if owned.is_symlink() or hashlib.sha256(owned.read_bytes()).hexdigest() != old_sha:
        stop('Compose changed during validation; original backup retained.')
    os.replace(candidate, owned)
finally:
    candidate.unlink(missing_ok=True)
print('Original Compose and narrow gateway inspection preserved at ' + str(backup))
print('Only command changed; PKI, SQLite, client bundle and MVP remain untouched.')
print(compose(owned, 'up', '--detach', '--no-deps', '--pull', 'never', 'gateway'), end='')
print('Gateway recreated with explicit port 18770. Root must now verify mTLS status/health.')
PY

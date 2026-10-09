#!/usr/bin/env python3
"""Read-only --check (default); --apply fixes one reviewed Docker-driver endpoint.

No sandbox create/start, model call, image pull, daemon restart or container
recreation. Preserves the file inode because gateway.toml is a file bind mount.
"""
import argparse
import datetime
import hashlib
import io
import json
import os
from pathlib import Path
import socket
import stat
import subprocess
import tarfile
import time
import tomllib
import urllib.request
import uuid

STATE = Path('/var/lib/weiwu-openshell-v012')
CONFIG = STATE / 'gateway.toml'
OLD_SHA = '54d63287df601a4538c842525849d9dd0ca406c8d0e77fc5c8a3448fda41b2ce'
OLD_ENDPOINT = 'https://host.openshell.internal:18770'
NEW_ENDPOINT = 'https://127.0.0.1:18770'
OLD_LINE = b'grpc_endpoint = "https://host.openshell.internal:18770"'
NEW_LINE = b'grpc_endpoint = "https://127.0.0.1:18770"'
GATEWAY_IMAGE = 'ghcr.io/nvidia/openshell/gateway:0.1.2@sha256:2fe4dad9118e14ab80a8258b545ea6e6cd74c3469e24ad4e6610f964d98913a2'
SUPERVISOR_IMAGE = 'ghcr.io/nvidia/openshell/supervisor:0.1.2@sha256:d7b5264bb6bc56f4796e6fa3617b8e4a8d785be0b7293542efd8cc250b0fb67a'
PROJECT = 'weiwu-openshell-v012'
FAILED_ID = '22a0fa90-8a07-4b0a-a921-373f0d7571bd'
FAILED_NAME = 'wwp-57ef585b3a37'
INSPECT = ('{"Id":{{json .Id}},"Image":{{json .Config.Image}},"Running":{{json .State.Running}},'
           '"Labels":{{json .Config.Labels}},"Network":{{json .HostConfig.NetworkMode}},'
           '"ExtraHosts":{{json .HostConfig.ExtraHosts}},"Path":{{json .Path}},"Args":{{json .Args}},'
           '"Ports":{{json .HostConfig.PortBindings}},"Mounts":{{json .Mounts}}}')
ENDPOINT_ONLY = '{{range .Config.Env}}{{if eq (index (split . "=") 0) "OPENSHELL_ENDPOINT"}}{{println .}}{{end}}{{end}}'
ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': '/root', 'LC_ALL': 'C'}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def write_new(path, data):
    with open(path, 'xb') as stream:
        stream.write(data); stream.flush(); os.fsync(stream.fileno())


def canonical(path):
    path = Path(path)
    require(path.is_absolute(), 'Expected an absolute administrator path.')
    for item in [*reversed(path.parents), path]:
        info = item.lstat()
        require(not stat.S_ISLNK(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022,
                'Administrator path is not canonical/root-owned/protected: ' + str(item))
    return path


def run(args, timeout=25, binary=False):
    result = subprocess.run(args, env=ENV, capture_output=True, text=not binary, timeout=timeout)
    require(result.returncode == 0, 'Command failed: ' + args[0] + ' ' + args[1] + ' (exit ' + str(result.returncode) + ').')
    return result.stdout


def docker(*args, **kwargs):
    return run(['docker', '--host', 'unix:///var/run/docker.sock', *args], **kwargs)


def records():
    return [json.loads(docker('inspect', '--format', INSPECT, ident))
            for ident in docker('ps', '--all', '--quiet', '--no-trunc').split()]


def check_inventory(items, running=True):
    gateways = [item for item in items if (item.get('Labels') or {}).get('com.docker.compose.project') == PROJECT
                and item['Labels'].get('com.docker.compose.service') == 'gateway']
    require(len(gateways) == 1, 'Expected the one existing gateway.')
    gateway = gateways[0]
    require(gateway['Image'] == GATEWAY_IMAGE and gateway['Path'] == '/usr/local/bin/openshell-gateway'
            and gateway['Args'] == ['--bind-address', '0.0.0.0', '--port', '18770'] and gateway['Running'] == running,
            'Actual gateway image/command/state does not match the fixed deployment.')
    require(gateway['Ports'] == {'18770/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '18770'}],
                                '18771/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '18771'}]}, 'Gateway publications changed.')
    mounts = [mount for mount in gateway['Mounts'] if mount.get('Destination') == '/etc/openshell/gateway.toml']
    require(len(mounts) == 1 and mounts[0].get('Type') == 'bind' and mounts[0].get('Source') == str(CONFIG)
            and not mounts[0].get('RW'), 'Expected the unchanged readonly config file bind mount.')
    probes = []
    for item in items:
        if item['Id'] == gateway['Id']:
            continue
        labels = item.get('Labels') or {}
        require(not item['Running'], 'An employee or another container is active; no repair is allowed.')
        if labels.get('openshell.ai/sandbox-id') != FAILED_ID:
            continue  # Never touch any unrelated stopped container.
        require(labels.get('openshell.ai/managed-by') == 'openshell'
                and labels.get('openshell.ai/sandbox-name') == FAILED_NAME
                and labels.get('openshell.ai/sandbox-namespace') == PROJECT, 'Failed probe identity changed.')
        role = labels.get('openshell.ai/isolation-role')
        require(role in ('sandbox', 'supervisor'), 'Unexpected failed-probe container role.')
        if role == 'sandbox':
            require(item['Network'] == 'none', 'Workload does not have the expected network=none fence.')
        else:
            require(item['Network'] == 'host' and not item.get('ExtraHosts'), 'Supervisor does not match known host/alias failure.')
        probes.append({'id': item['Id'], 'role': role, 'network': item['Network'], 'extraHosts': item.get('ExtraHosts')})
    return gateway, probes


def patch_bytes(original):
    require(sha(original) == OLD_SHA and original.count(OLD_LINE) == 1, 'Deployed config differs from the exact reviewed old SHA/endpoint.')
    candidate = original.replace(OLD_LINE, NEW_LINE, 1)
    before, after = tomllib.loads(original.decode()), tomllib.loads(candidate.decode())
    require(before['openshell']['drivers']['docker']['grpc_endpoint'] == OLD_ENDPOINT, 'Unexpected old endpoint.')
    before['openshell']['drivers']['docker']['grpc_endpoint'] = NEW_ENDPOINT
    require(before == after, 'Candidate changed configuration beyond the unique endpoint.')
    return candidate


def rewrite_in_place(path, expected, candidate):
    canonical(path)
    fd = os.open(path, os.O_RDWR | getattr(os, 'O_NOFOLLOW', 0))
    with os.fdopen(fd, 'r+b') as stream:
        if os.name == 'posix':
            import fcntl
            fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        before = os.fstat(stream.fileno())
        require(stream.read() == expected and path.stat().st_ino == before.st_ino, 'Config bytes/inode changed before update.')
        stream.seek(0); stream.write(candidate); stream.truncate(); stream.flush(); os.fsync(stream.fileno())
        require(path.stat().st_ino == before.st_ino and path.read_bytes() == candidate, 'Config write/inode verification failed.')
    return before.st_ino


def protected():
    result = {'compose.yaml': sha(canonical(STATE / 'compose.yaml').read_bytes())}
    for path in sorted(canonical(STATE / 'tls').rglob('*')):
        canonical(path)
        if path.is_file():
            result[str(path.relative_to(STATE))] = sha(path.read_bytes())
    return result


def database_files():
    result = {name: canonical(STATE / name).read_bytes() for name in ('gateway.db', 'gateway.db-wal', 'gateway.db-shm') if (STATE / name).exists()}
    require('gateway.db' in result, 'Existing gateway SQLite database is absent.')
    return result


def cli(*args):
    # Run the existing private official CLI as its owner, never a user-writable
    # executable as root. Only documented GET/status are used here.
    root = '/home/jj/.local/share/weiwu'
    return json.loads(run(['runuser', '--user', 'jj', '--', 'env', 'HOME=' + root + '/home',
                           'XDG_CONFIG_HOME=' + root + '/home/.config', 'OPENSHELL_COLOR=never',
                           root + '/runtime/openshell-v0.1.2/openshell', '--gateway', PROJECT, *args, '--output', 'json']))


def health():
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open('http://127.0.0.1:18771/health', timeout=3) as response:
        data = json.loads(response.read(8192))
    require(data.get('status') == 'healthy' and data.get('version') == '0.1.2', 'Gateway health/version verification failed.')
    return data


def mounted_bytes(container):
    archive = docker('cp', container + ':/etc/openshell/gateway.toml', '-', binary=True)
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        files = [member for member in tar.getmembers() if member.isfile()]
        require(len(files) == 1 and files[0].size < 65536, 'Unexpected copied config archive.')
        return tar.extractfile(files[0]).read()  # No tar entry is extracted onto the host.


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    flags = parser.add_mutually_exclusive_group()
    flags.add_argument('--check', action='store_true')
    flags.add_argument('--apply', action='store_true')
    options = parser.parse_args()
    os.umask(0o077)
    require(os.geteuid() == 0 and os.uname().machine == 'x86_64', 'Run the reviewed helper via local sudo on Linux amd64.')
    original = canonical(CONFIG).read_bytes()
    candidate = patch_bytes(original)
    config = tomllib.loads(original.decode())['openshell']
    require(config['gateway']['disable_tls'] is False and '127.0.0.1' in config['gateway']['server_sans']
            and config['gateway']['guest_tls_ca'] == str(STATE / 'tls/ca.crt')
            and config['drivers']['docker']['supervisor_image'] == SUPERVISOR_IMAGE, 'TLS/pinned supervisor configuration changed.')
    run(['openssl', 'x509', '-in', str(canonical(STATE / 'tls/server/tls.crt')), '-noout', '-checkip', '127.0.0.1'])
    gateway, probes = check_inventory(records())
    for probe in probes:
        if probe['role'] == 'supervisor':
            endpoint = docker('inspect', '--format', ENDPOINT_ONLY, probe['id']).strip().splitlines()
            require(endpoint == ['OPENSHELL_ENDPOINT=' + OLD_ENDPOINT], 'Actual supervisor endpoint differs from the known failure.')
            probe['endpoint'] = OLD_ENDPOINT
    failed = cli('sandbox', 'get', FAILED_NAME)
    require(failed.get('id') == FAILED_ID and failed.get('phase') == 'Error'
            and any(item.get('reason') == 'ControlSupervisorStartFailed' for item in failed.get('conditions', [])), 'Failed probe record differs from the known failure.')
    status = cli('status')
    require(status.get('status') == 'connected' and status.get('version') == '0.1.2'
            and status.get('authentication', {}).get('status') == 'authenticated'
            and status.get('server') == NEW_ENDPOINT, 'Existing loopback mTLS route is not confirmed.')
    try:
        socket.getaddrinfo('host.openshell.internal', None)
    except socket.gaierror:
        pass
    else:
        raise RuntimeError('Old hostname now resolves; do not assume the reviewed DNS failure.')
    health()
    identities = protected()
    audit = {'schema': 1, 'oldSha256': sha(original), 'newSha256': sha(candidate), 'gatewayContainerId': gateway['Id'],
             'failedProbeId': FAILED_ID, 'failedProbeName': FAILED_NAME, 'containers': probes,
             'supervisorInspection': 'present and checked' if any(p['role'] == 'supervisor' for p in probes) else 'absent after official failure cleanup; not an inspection pass',
             'modelCalls': 0, 'sandboxOperations': 0, 'dockerDaemonRestarts': 0, 'protectedSha256': identities}
    if not options.apply:
        print(json.dumps(audit, indent=2)); return
    evidence = STATE / ('supervisor-endpoint-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ-') + uuid.uuid4().hex[:8])
    evidence.mkdir(mode=0o700)
    def save(**values):
        audit.update(values)
        with open(evidence / 'report.json', 'w', encoding='utf-8') as stream:
            stream.write(json.dumps(audit, indent=2) + '\n'); stream.flush(); os.fsync(stream.fileno())
    write_new(evidence / 'gateway.toml.original', original)
    save(stage='preflight passed', evidence=str(evidence))
    frozen = None
    try:
        current, _ = check_inventory(records())
        require(current == gateway and CONFIG.read_bytes() == original and protected() == identities, 'State changed since preflight; no repair made.')
        docker('stop', '--time', '20', gateway['Id'], timeout=30)
        stopped, _ = check_inventory(records(), running=False)
        require(stopped['Id'] == gateway['Id'], 'Gateway stop identity changed.')
        frozen = database_files()
        for name, data in frozen.items():
            write_new(evidence / (name + '.stopped.backup'), data)
        save(stage='gateway stopped and database backed up', databaseSha256={name: sha(data) for name, data in frozen.items()})
        require(protected() == identities, 'PKI/Compose changed while stopping.')
        inode = rewrite_in_place(CONFIG, original, candidate)
        save(stage='unique endpoint updated with original inode', configInode=inode)
        require(database_files() == frozen and protected() == identities, 'Stopped database/PKI changed before start.')
        docker('start', gateway['Id'])
        started, _ = check_inventory(records())
        require(started == gateway and mounted_bytes(gateway['Id']) == candidate, 'Original container/mounted config verification failed.')
        last_error = None
        for _ in range(10):
            try:
                post_health = health(); last_error = None; break
            except Exception as error:
                last_error = error; time.sleep(1)
        require(last_error is None, 'Gateway did not become healthy after the bounded wait.')
        require(protected() == identities, 'PKI/Compose changed after restart.')
        post_status = cli('status')
        require(post_status.get('status') == 'connected' and post_status.get('version') == '0.1.2'
                and post_status.get('authentication', {}).get('status') == 'authenticated'
                and post_status.get('server') == NEW_ENDPOINT, 'Gateway post-repair mTLS status verification failed.')
        save(stage='passed', health=post_health, gatewayStatus=post_status,
             sameGatewayContainer=True, mountedConfigSha256=sha(candidate))
        print(json.dumps({'passed': True, 'evidence': str(evidence), 'gatewayContainerId': gateway['Id'],
                          'endpoint': NEW_ENDPOINT, 'sandboxIsolation': 'not tested', 'modelCalls': 0}))
    except Exception as error:
        save(stage='failed', failureType=type(error).__name__, failure=str(error))
        # A timeout/disconnect is an unknown operation result; preserve evidence
        # instead of sending another stop/start or overwriting configuration.
        if not isinstance(error, subprocess.TimeoutExpired) and frozen is not None:
            try:
                current, _ = check_inventory(records(), running=False)
                require(current['Id'] == gateway['Id'] and database_files() == frozen and protected() == identities,
                        'Guarded rollback cannot prove unchanged stopped DB/PKI/container.')
                now = CONFIG.read_bytes()
                require(now in (original, candidate), 'Config changed independently; refusing rollback.')
                if now == candidate:
                    rewrite_in_place(CONFIG, candidate, original)
                docker('start', gateway['Id'])
                save(originalEndpointRestored=True)
            except Exception as rollback_error:
                save(rollbackStopped=str(rollback_error))
        print('Private evidence: ' + str(evidence))
        raise


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('STOP: ' + str(error)); raise SystemExit(1)

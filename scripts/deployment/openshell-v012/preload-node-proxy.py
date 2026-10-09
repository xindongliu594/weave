#!/usr/bin/env python3
"""Administrator-only, one-image preload; --check is read-only.

Uses Docker's documented systemd daemon proxy configuration temporarily under
/run, not the user CLI proxy environment. Never creates/retries a sandbox,
recreates the gateway, changes TLS/policy/credentials, or grants socket access.
Two Docker restarts and a brief stop/start of the SAME gateway container are
required. Run only after reviewing the check output and downtime.
Sources: https://docs.docker.com/engine/daemon/proxy/
         https://docs.docker.com/reference/cli/docker/image/pull/
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import signal
import socket
import stat
import subprocess
import sys
import time
import tomllib
import urllib.error
import urllib.request
import uuid

NODE_IMAGE = 'docker.io/library/node:24.19.0-bookworm-slim@sha256:e5a8dee7bc1e6a215d224a7ef8206f7e77271bc3cabd5febf2beafac0674f174'
NODE_CONFIG = 'sha256:622f209f6c16ba5af4d9a337cae6577d096f17174b904cfc6a5b0c81a2679c24'
NODE_MANIFEST = NODE_IMAGE.rsplit('@', 1)[1]
GATEWAY_IMAGE = 'ghcr.io/nvidia/openshell/gateway:0.1.2@sha256:2fe4dad9118e14ab80a8258b545ea6e6cd74c3469e24ad4e6610f964d98913a2'
PROJECT = 'weiwu-openshell-v012'
STATE = Path('/var/lib/weiwu-openshell-v012')
DROPIN = Path('/run/systemd/system/docker.service.d/99-weiwu-preload-proxy.conf')
PROXY = 'http://127.0.0.1:7897'
DROPIN_BYTES = ('[Service]\nEnvironment="HTTP_PROXY=' + PROXY + '"\n'
                'Environment="HTTPS_PROXY=' + PROXY + '"\n'
                'Environment="NO_PROXY=localhost,127.0.0.1,::1,host.openshell.internal,host.docker.internal"\n').encode()
INSPECT = ('{"Id":{{json .Id}},"ImageId":{{json .Image}},"Image":{{json .Config.Image}},'
           '"Args":{{json .Args}},"Path":{{json .Path}},"Running":{{json .State.Running}},'
           '"Restart":{{json .HostConfig.RestartPolicy.Name}},"Labels":{{json .Config.Labels}},'
           '"Ports":{{json .HostConfig.PortBindings}}}')


def fail(message):
    raise RuntimeError(message)


def canonical(path, required=True):
    """Reject symlinks at every existing component before root filesystem work."""
    path = Path(path)
    if not path.is_absolute():
        fail('Expected absolute administrator path.')
    for item in [*reversed(path.parents), path]:
        try:
            info = item.lstat()
        except FileNotFoundError:
            if item == path and not required:
                continue
            fail('Required canonical path is absent: ' + str(item))
        if stat.S_ISLNK(info.st_mode) or info.st_uid != 0:
            fail('Administrator path must be root-owned without symlinks: ' + str(item))
        if info.st_mode & 0o022:
            fail('Administrator path is group/world writable: ' + str(item))
    return path


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def static_unit(unit):
    """systemctl ExecStart includes changing PID/times/status, not configuration.

    Preserve the raw report but compare only path/argv/ignore_errors. The old
    schema's actual systemctl string is accepted without rewriting its evidence.
    """
    raw = unit.get('ExecStart', '')
    blocks = re.findall(r'\{([^{}]*)\}', raw)
    commands = []
    if blocks:
        for block in blocks:
            fields = dict(part.strip().split('=', 1) for part in block.split(' ; ') if '=' in part)
            if not all(key in fields for key in ('path', 'argv[]', 'ignore_errors')):
                fail('Unrecognized systemctl ExecStart static fields; preserve and review.')
            commands.append({key: fields[key].strip() for key in ('path', 'argv[]', 'ignore_errors')})
    elif '{' in raw or '}' in raw or not raw:
        fail('Unrecognized systemctl ExecStart serialization; preserve and review.')
    else:
        # Retains compatibility with a plain command serialization in local
        # fixtures/older systemctl; unlike the structured form it has no status.
        commands = [{'command': tuple(shlex.split(raw))}]
    return {'ActiveState': unit.get('ActiveState'), 'FragmentPath': unit.get('FragmentPath'),
            'DropInPaths': unit.get('DropInPaths'), 'EnvironmentFiles': unit.get('EnvironmentFiles'),
            'Environment': sorted(shlex.split(unit.get('Environment', ''))), 'ExecStart': commands}


def no_proxy_environment(raw):
    names = []
    for part in raw.split(b'\0'):
        if b'=' not in part:
            continue
        name, value = part.split(b'=', 1)
        if name.lower() in (b'http_proxy', b'https_proxy', b'no_proxy', b'all_proxy'):
            names.append(name.decode('ascii', errors='replace'))
    if names:
        fail('Actual dockerd process still contains proxy environment variables; preserve and review.')
    return {'proxyVariableNames': []}


def protected_manifest(state=STATE):
    """Hash PKI/config only; no private bytes are printed or copied into JSON."""
    result = {}
    for top in ('tls', 'compose.yaml', 'gateway.toml'):
        path = canonical(state / top)
        paths = sorted(path.rglob('*')) if path.is_dir() else [path]
        for item in paths:
            canonical(item)
            if item.is_file():
                result[str(item.relative_to(state))] = digest(item)
    if not result:
        fail('Missing existing gateway configuration/PKI.')
    return result


def verify_gateway(records, require_running=True):
    # Even stopped strangers are rejected: daemon restart can honor their restart
    # policies. This script owns only the one pre-existing gateway container.
    if len(records) != 1:
        fail('Expected only the existing gateway container; preserve and review all other containers.')
    item = records[0]
    labels = item.get('Labels') or {}
    if (item.get('Image') != GATEWAY_IMAGE or labels.get('com.docker.compose.project') != PROJECT
            or labels.get('com.docker.compose.service') != 'gateway'
            or (require_running and not item.get('Running')) or item.get('Restart') != 'unless-stopped'
            or item.get('Path') != '/usr/local/bin/openshell-gateway'
            or item.get('Args') != ['--bind-address', '0.0.0.0', '--port', '18770']):
        fail('Actual running gateway is not the reviewed fixed deployment.')
    ports = {'18770/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '18770'}],
             '18771/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '18771'}]}
    if item.get('Ports') != ports:
        fail('Gateway loopback publications changed.')
    return item


def verify_node(item):
    refs = item.get('RepoDigests') or []
    expected = 'node@' + NODE_IMAGE.rsplit('@', 1)[1]
    if (item.get('Id') not in (NODE_CONFIG, NODE_MANIFEST) or item.get('Os') != 'linux'
            or item.get('Architecture') != 'amd64'
            or not any(ref.removeprefix('docker.io/').removeprefix('library/') == expected for ref in refs)):
        fail('Pinned Node image identity/platform/repository digest did not match.')
    # Docker's classic store returns the config digest; its containerd store
    # returns target/manifest digest. Both are exact independently pinned IDs.
    return {'imageId': item['Id'], 'identityKind': 'config' if item['Id'] == NODE_CONFIG else 'manifest',
            'os': item['Os'], 'architecture': item['Architecture'],
            'repositoryDigest': 'docker.io/library/' + expected}


class Preloader:
    def __init__(self):
        self.env = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C', 'HOME': '/root'}
        self.gateway = None
        self.report = None
        self.drop_created = False
        self.gateway_stopped = False
        self.db_sha = None
        self.original_protected = None
        self.original_unit = None
        self.daemon_needs_restore = False
        self.database_files = None

    def run(self, args, timeout=30, check=True):
        result = subprocess.run(args, env=self.env, capture_output=True, text=True,
                                timeout=timeout, check=False)
        if check and result.returncode:
            # Do not echo daemon environments, registry authentication or keys.
            fail('Command failed: ' + args[0] + ' ' + args[1] + ' (exit ' + str(result.returncode) + ').')
        return result

    def docker(self, *args, **kwargs):
        return self.run(['docker', '--host', 'unix:///var/run/docker.sock', *args], **kwargs)

    def unit(self):
        result = self.run(['systemctl', 'show', 'docker.service', '--no-pager',
                          '-p', 'ActiveState', '-p', 'FragmentPath', '-p', 'DropInPaths',
                          '-p', 'Environment', '-p', 'EnvironmentFiles', '-p', 'ExecStart']).stdout
        return dict(line.split('=', 1) for line in result.splitlines() if '=' in line)

    def daemon_environment(self):
        # Unit metadata alone does not prove the existing process restarted with
        # restored settings. Read only the live dockerd process, never print env.
        raw_pid = self.run(['systemctl', 'show', 'docker.service', '--property=MainPID', '--value']).stdout.strip()
        if not raw_pid.isdigit() or int(raw_pid) <= 1:
            fail('Docker has no confirmed live MainPID; preserve and review.')
        process = Path('/proc') / raw_pid
        if (process / 'comm').read_text().strip() != 'dockerd':
            fail('Docker MainPID does not identify dockerd; preserve and review.')
        proof = no_proxy_environment((process / 'environ').read_bytes())
        if self.run(['systemctl', 'show', 'docker.service', '--property=MainPID', '--value']).stdout.strip() != raw_pid:
            fail('Docker PID changed during environment verification; preserve and review.')
        return {'mainPid': int(raw_pid), **proof}

    def inventory(self):
        ids = self.docker('ps', '--all', '--quiet', '--no-trunc').stdout.split()
        return [json.loads(self.docker('inspect', '--format', INSPECT, item).stdout) for item in ids]

    def node(self):
        result = self.docker('image', 'inspect', NODE_IMAGE, check=False)
        if result.returncode:
            return None
        items = json.loads(result.stdout)
        if len(items) != 1:
            fail('Ambiguous pinned Node image inspection.')
        return verify_node(items[0])

    def checkpoint(self, **items):
        self.report_data.update(items)
        if self.report is not None:
            with open(self.report, 'w', encoding='utf-8') as stream:
                json.dump(self.report_data, stream, indent=2)
                stream.write('\n')
                stream.flush()
                os.fsync(stream.fileno())

    def preflight(self):
        if sys.platform != 'linux' or os.uname().machine != 'x86_64':
            fail('Only the reviewed Linux amd64 host is supported.')
        canonical(STATE)
        canonical('/run/systemd/system')
        if Path('/etc/docker/daemon.json').exists() or Path('/etc/docker/daemon.json').is_symlink():
            fail('Existing daemon.json needs separate review; it takes precedence over proxy environment.')
        if DROPIN.exists() or DROPIN.is_symlink():
            fail('Existing temporary preload drop-in needs rollback/review; never overwrite it.')
        if DROPIN.parent.exists():
            canonical(DROPIN.parent)
        unit = self.unit()
        if (unit.get('ActiveState') != 'active' or unit.get('FragmentPath') != '/usr/lib/systemd/system/docker.service'
                or unit.get('DropInPaths') or unit.get('EnvironmentFiles')):
            fail('Docker service differs from the reviewed plain active system unit.')
        proxy_keys = {part.split('=', 1)[0].lower() for part in shlex.split(unit.get('Environment', ''))}
        if proxy_keys & {'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy'}:
            fail('Existing daemon proxy environment must be preserved and separately reviewed.')
        if any(flag in unit.get('ExecStart', '') for flag in ('--http-proxy', '--https-proxy', '--config-file', '--no-proxy')):
            fail('Existing daemon CLI configuration needs separate review.')
        if os.geteuid() != 0:
            fail('Use local sudo for read-only socket inspection; no password is read by this script.')
        self.gateway = verify_gateway(self.inventory())
        self.original_unit = unit
        self.original_protected = protected_manifest()
        config = tomllib.loads((STATE / 'gateway.toml').read_text())
        driver = config['openshell']['drivers']['docker']
        if driver.get('image_pull_policy') != 'if_not_present':
            fail('Preloading needs the reviewed if_not_present policy; Always would pull again after rollback.')
        cached = self.node()
        self.report_data = {'schema': 1, 'image': NODE_IMAGE, 'gatewayContainerId': self.gateway['Id'],
                            'proxy': PROXY, 'mode': 'read-only check', 'modelCalls': 0,
                            'sandboxOperations': 0, 'alreadyCached': bool(cached),
                            'protectedSha256': self.original_protected,
                            'originalUnit': unit, 'originalGateway': self.gateway}
        if cached:
            self.report_data['verifiedNode'] = cached
            return
        with socket.create_connection(('127.0.0.1', 7897), timeout=3):
            pass
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({'https': PROXY}))
        try:
            with opener.open(urllib.request.Request('https://registry-1.docker.io/v2/', method='HEAD'), timeout=10) as response:
                status = response.status
        except urllib.error.HTTPError as error:
            status = error.code
        if status not in (200, 401):
            fail('Existing loopback proxy did not reach HTTPS Docker Hub registry.')
        self.report_data['registryProxyHeadStatus'] = status

    def wait_docker(self):
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if self.docker('info', '--format', '{{.ServerVersion}}', timeout=4, check=False).returncode == 0:
                return
            time.sleep(1)
        fail('Docker did not become ready within the bounded wait.')

    def restore(self):
        errors = []
        if self.drop_created or self.daemon_needs_restore:
            try:
                if self.drop_created:
                    canonical(DROPIN)
                    if DROPIN.read_bytes() != DROPIN_BYTES:
                        fail('Temporary drop-in changed; refusing to delete another administrator edit.')
                    DROPIN.unlink()  # The one exact file created by this invocation only.
                    self.drop_created = False
                # Old helper may have already completed the second restart but
                # rejected its changing ExecStart PID/timestamps. If static unit
                # AND live process env are restored, do not restart a third time.
                already_restored = static_unit(self.unit()) == static_unit(self.original_unit)
                if already_restored:
                    process_proof = self.daemon_environment()
                else:
                    self.run(['systemctl', 'daemon-reload'])
                    records = self.inventory()
                    if len(records) != 1 or records[0]['Id'] != self.gateway['Id'] or records[0]['Running']:
                        fail('Container set changed before rollback restart; preserve and review.')
                    self.run(['systemctl', 'restart', 'docker.service'], timeout=60)
                    self.wait_docker()
                    process_proof = self.daemon_environment()
                if static_unit(self.unit()) != static_unit(self.original_unit):
                    fail('Docker system unit/environment did not restore exactly.')
                self.daemon_needs_restore = False
                self.checkpoint(proxyRestored=True, daemonProcessProof=process_proof,
                                skippedAlreadyCompletedDaemonRestart=already_restored)
            except Exception as error:
                errors.append(type(error).__name__ + ': ' + str(error))
        if self.gateway_stopped and not errors:
            try:
                if self.db_sha is None:
                    fail('Gateway stop/database freeze was not confirmed; review before starting.')
                if protected_manifest() != self.original_protected or digest(STATE / 'gateway.db') != self.db_sha:
                    fail('Gateway DB/PKI/config changed while stopped; preserve evidence and review before start.')
                if self.database_files is not None:
                    current = {name: digest(canonical(STATE / name)) for name in ('gateway.db', 'gateway.db-wal', 'gateway.db-shm') if (STATE / name).exists()}
                    if current != self.database_files:
                        fail('SQLite sidecar files changed while stopped; preserve and review before start.')
                # Never use Compose up/create. Restart the SAME preserved ID only.
                self.docker('start', self.gateway['Id'])
                self.gateway_stopped = False
                restored = verify_gateway(self.inventory())
                if restored != self.gateway:
                    fail('Original gateway container identity/configuration changed.')
                self.checkpoint(gatewayRestored=True)
            except Exception as error:
                errors.append(type(error).__name__ + ': ' + str(error))
        if errors:
            self.checkpoint(**({'recoveryRollbackErrors': errors} if self.report_data.get('sourceReportSha256')
                               else {'rollbackErrors': errors}))
            fail('Rollback needs administrator attention; gateway remains stopped when safety checks fail. See private report.')

    def apply(self):
        if self.report_data['alreadyCached']:
            print(json.dumps({**{key: value for key, value in self.report_data.items()
                                if key not in ('originalUnit', 'originalGateway')},
                              'mode': 'cached verified; no changes'}, indent=2))
            return
        # Recheck all resources immediately before the first mutation.
        if verify_gateway(self.inventory()) != self.gateway or static_unit(self.unit()) != static_unit(self.original_unit):
            fail('Docker/gateway changed since preflight; no mutation made.')
        if protected_manifest() != self.original_protected:
            fail('Gateway protected files changed since preflight; no mutation made.')
        name = 'node-preload-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ-') + uuid.uuid4().hex[:8]
        evidence = STATE / name
        evidence.mkdir(mode=0o700)
        self.report = evidence / 'report.json'
        self.checkpoint(mode='administrator temporary proxy preload', evidence=str(evidence),
                        plannedDockerRestarts=2, gatewayRestored=False, proxyRestored=False)
        try:
            # Mark before dispatch: a timeout/disconnect can leave stop completed
            # even when the client did not receive its result. Never assume replay.
            self.gateway_stopped = True
            self.checkpoint(stopDispatched=True)
            self.docker('stop', '--time', '20', self.gateway['Id'], timeout=30)
            stopped = self.inventory()
            if len(stopped) != 1 or stopped[0]['Id'] != self.gateway['Id'] or stopped[0]['Running']:
                fail('Gateway stop not confirmed; do not configure daemon proxy.')
            self.db_sha = digest(canonical(STATE / 'gateway.db'))
            self.database_files = {'gateway.db': self.db_sha}
            # Gateway is closed: preserve exact SQLite bytes without accessing any
            # table/credential. No database file is overwritten, restored or edited.
            with open(evidence / 'gateway.db.stopped.backup', 'xb') as stream:
                stream.write((STATE / 'gateway.db').read_bytes())
                stream.flush(); os.fsync(stream.fileno())
            for suffix in ('-wal', '-shm'):
                path = STATE / ('gateway.db' + suffix)
                if path.exists():
                    canonical(path)
                    self.database_files[path.name] = digest(path)
                    with open(evidence / ('gateway.db' + suffix + '.stopped.backup'), 'xb') as stream:
                        stream.write(path.read_bytes())
            self.checkpoint(stoppedDatabaseSha256=self.db_sha, stoppedDatabaseFiles=self.database_files, gatewayStopped=True)
            DROPIN.parent.mkdir(mode=0o755, exist_ok=True)
            canonical(DROPIN.parent)
            with open(DROPIN, 'xb') as stream:
                self.drop_created = True
                stream.write(DROPIN_BYTES); stream.flush(); os.fsync(stream.fileno())
            self.checkpoint(temporaryDropinSha256=digest(DROPIN))
            self.daemon_needs_restore = True
            self.checkpoint(daemonProxyRestartDispatched=True)
            self.run(['systemctl', 'daemon-reload'])
            self.run(['systemctl', 'restart', 'docker.service'], timeout=60)
            self.wait_docker()
            if any(item['Running'] for item in self.inventory()):
                fail('Unexpected container started after daemon restart; do not pull.')
            live_env = shlex.split(self.unit().get('Environment', ''))
            if 'HTTPS_PROXY=' + PROXY not in live_env or 'HTTP_PROXY=' + PROXY not in live_env:
                fail('Temporary proxy was not loaded into the daemon service.')
            # One pull, fixed image, official TLS; no retries, floating tags or
            # alternate registry. Disconnect/timeout cancels Docker's pull client.
            self.checkpoint(pullAttemptCount=1, pullDispatched=True)
            result = self.docker('image', 'pull', '--platform', 'linux/amd64', NODE_IMAGE,
                                 timeout=600, check=False)
            self.checkpoint(pullAttemptCount=1, pullExitCode=result.returncode)
            if result.returncode:
                fail('The one pinned pull failed; no automatic repeat.')
            self.checkpoint(verifiedNode=self.node())
            if not self.report_data['verifiedNode']:
                fail('Pinned image absent after successful pull exit.')
            self.checkpoint(preloadPassed=True)
        except BaseException as error:
            self.checkpoint(preloadPassed=False, failureType=type(error).__name__, failure=str(error))
            raise
        finally:
            self.restore()
        print(json.dumps({'passed': True, 'image': NODE_IMAGE, 'evidence': str(evidence),
                          'gatewayContainerId': self.gateway['Id'], 'proxyRestored': True,
                          'modelCalls': 0, 'sandboxOperations': 0, 'sandboxIsolation': 'not tested'}, indent=2))


def interrupted(number, frame):
    raise KeyboardInterrupt('Interrupted; restoring temporary daemon settings.')


def rollback(evidence):
    """Manual interrupted-process recovery; exact owned report/file only."""
    evidence = Path(evidence)
    if (evidence.parent != STATE or not re.fullmatch(r'node-preload-\d{8}T\d{6}\.\d{6}Z-[a-f0-9]{8}', evidence.name)):
        fail('Rollback needs the unique private evidence directory from this script.')
    canonical(evidence)
    report = canonical(evidence / 'report.json')
    data = json.loads(report.read_text())
    if data.get('image') != NODE_IMAGE or data.get('proxy') != PROXY or data.get('evidence') != str(evidence):
        fail('Rollback report is not the fixed reviewed operation.')
    if os.geteuid() != 0:
        fail('Rollback requires local sudo authentication.')
    worker = Preloader()
    # Never edit the old failed-operation report. All recovery progress goes to a
    # unique root-owned private subdirectory, with original raw bytes/SHA retained.
    recovery_name = 'recovery-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ-') + uuid.uuid4().hex[:8]
    recovery = evidence / recovery_name
    recovery.mkdir(mode=0o700)
    canonical(recovery)
    worker.report = recovery / 'report.json'
    worker.report_data = {**data, 'sourceReportSha256': digest(report), 'recoveryReport': str(worker.report)}
    with open(recovery / 'source-report.raw.json', 'xb') as stream:
        stream.write(report.read_bytes()); stream.flush(); os.fsync(stream.fileno())
    worker.gateway = data['originalGateway']
    worker.original_unit = data['originalUnit']
    worker.original_protected = data['protectedSha256']
    actual = verify_gateway(worker.inventory(), require_running=False)
    if {**actual, 'Running': True} != worker.gateway:
        fail('Gateway container identity/config changed; do not roll back automatically.')
    if worker.original_unit.get('DropInPaths') or worker.original_unit.get('EnvironmentFiles'):
        fail('Unsupported original Docker unit; preserve and review.')
    current = worker.unit()
    allowed_dropins = ('', str(DROPIN))
    if current.get('DropInPaths') not in allowed_dropins or current.get('FragmentPath') != worker.original_unit.get('FragmentPath'):
        fail('Another administrator changed the Docker unit; preserve and review.')
    if Path('/etc/docker/daemon.json').exists() or Path('/etc/docker/daemon.json').is_symlink():
        fail('New daemon.json needs separate review before rollback.')
    worker.drop_created = DROPIN.exists() or DROPIN.is_symlink()
    if worker.drop_created:
        canonical(DROPIN)
        if DROPIN.read_bytes() != DROPIN_BYTES:
            fail('Temporary drop-in changed; refusing to delete another administrator edit.')
    worker.daemon_needs_restore = bool(data.get('daemonProxyRestartDispatched') and not data.get('proxyRestored'))
    worker.gateway_stopped = not actual['Running']
    worker.db_sha = data.get('stoppedDatabaseSha256')
    worker.database_files = data.get('stoppedDatabaseFiles')
    with open(worker.report, 'x', encoding='utf-8') as stream:
        json.dump(worker.report_data, stream, indent=2)
        stream.write('\n')
    # Always attest the live process on recovery, including an old report whose
    # unit metadata was restored but whose proxyRestored checkpoint is absent.
    if not worker.drop_created and static_unit(current) == static_unit(worker.original_unit):
        proof = worker.daemon_environment()
        worker.daemon_needs_restore = False
        worker.checkpoint(proxyRestored=True, daemonProcessProof=proof,
                          skippedAlreadyCompletedDaemonRestart=True)
    # A crash before the frozen DB checkpoint is intentionally not auto-started;
    # the owner must inspect the stop result and preserve the original record.
    worker.restore()
    print(json.dumps({'rollbackPassed': True, 'evidence': str(evidence),
                      'modelCalls': 0, 'sandboxOperations': 0}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    flags = parser.add_mutually_exclusive_group()
    flags.add_argument('--check', action='store_true', help='Read-only administrator preflight (default).')
    flags.add_argument('--apply', action='store_true', help='Temporarily stop gateway/restart Docker/pull/restore.')
    flags.add_argument('--rollback', metavar='EVIDENCE_DIRECTORY', help='Recover an interrupted invocation using its private report.')
    # Fixed image/proxy only; no arbitrary commands, policy changes or key paths.
    args = sys.argv[1:]
    options = parser.parse_args(args)
    os.umask(0o077)
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    worker = Preloader()
    try:
        if options.rollback:
            rollback(options.rollback)
            return 0
        worker.preflight()
        if not options.apply:
            print(json.dumps({key: value for key, value in worker.report_data.items()
                              if key not in ('originalUnit', 'originalGateway')}, indent=2))
            print('Read-only check complete. Apply briefly stops the SAME gateway and restarts Docker twice; no sandbox operation.')
        else:
            worker.apply()
    except (Exception, KeyboardInterrupt) as error:
        print('STOP: ' + str(error), file=sys.stderr)
        if worker.report is not None:
            print('Private evidence: ' + str(worker.report.parent), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

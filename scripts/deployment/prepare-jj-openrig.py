#!/usr/bin/env python3
"""Prepare/check/apply/rollback ONE optional JJ OpenRig metadata service.

Default --check is read-only. --apply is an explicit operator action. This script
never changes weiwu-jj.service, calls models, or creates project queue items.
An interrupted materialization is queried by its recorded rig name, not replayed.
"""
from pathlib import Path
import argparse
import datetime
import hashlib
import importlib.util
import json
import os
import secrets
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('metadata_runner', HERE / 'openrig-metadata-runner.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
ROOT, BASE, PACKAGE, NODE, PORT, URL = runner.ROOT, runner.BASE, runner.PACKAGE, runner.NODE, runner.PORT, runner.URL
SERVICE = 'weiwu-openrig.service'
UNIT = Path('/home/jj/.config/systemd/user') / SERVICE
PROJECT = '4ae5cce4-73c1-420a-987f-83db54d196f2'
DEPARTMENT = '3c0cb5ee-0b24-4ef5-9957-8a048c7dae0a'
RIG_NAME = 'weiwu-pilot-3c0cb5ee'
EMPLOYEES = {'mgr-1': ('manager', 'manager'), 'dev-1': ('dev', 'developer'), 'qa-1': ('qa', 'qa')}
STATE = BASE / 'installation.json'
REPORT = None
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))

def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()

def content(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode()

def write_sync(file, data, exclusive=False):
    runner.checked_path(file.parent)
    runner.checked_path(file, exists=False)
    target = file if exclusive else file.with_name(file.name + '.' + str(uuid.uuid4()) + '.tmp')
    with target.open('xb') as stream:
        os.chmod(target, 0o600)
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    if not exclusive:
        os.replace(target, file)
    fd = os.open(file.parent, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)

def immutable(file, data):
    runner.checked_path(file, exists=False)
    if file.exists():
        if file.read_bytes() != data:
            raise RuntimeError('Refusing to overwrite changed owned file: ' + file.name)
    else:
        write_sync(file, data, exclusive=True)

def command(argv, environment=None, timeout=30, required=True):
    try:
        result = subprocess.run(argv, env=environment, cwd=BASE if BASE.exists() else ROOT,
                                capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        if REPORT is not None:
            REPORT['steps'].append({'command': argv, 'outcome': 'timeout', 'at': now()})
            save_report()
        raise RuntimeError('Command outcome unknown; inspect preserved evidence before retry')
    if REPORT is not None:
        REPORT['steps'].append({'command': argv, 'exit': result.returncode, 'stdout': result.stdout[-32000:], 'stderr': result.stderr[-16000:], 'at': now()})
        save_report()
    if required and result.returncode:
        raise RuntimeError('Command failed; inspect private evidence: ' + argv[0])
    return result

def save_report():
    if REPORT is not None:
        write_sync(Path(REPORT['evidence']), content(REPORT))

def show_service(name=SERVICE):
    result = command(['systemctl', '--user', 'show', name, '-p', 'LoadState', '-p', 'ActiveState', '-p', 'MainPID', '-p', 'FragmentPath'], required=False)
    if result.returncode:
        raise RuntimeError('User systemd service state unavailable')
    return dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)

def listening():
    with socket.socket() as sock:
        sock.settimeout(1)
        return sock.connect_ex(('127.0.0.1', PORT)) == 0

def get(url, token=False, timeout=10):
    headers = {'Authorization': 'Bearer ' + runner.clean_environment()['OPENRIG_TERMINAL_BEARER_TOKEN']} if token else {}
    try:
        with OPENER.open(urllib.request.Request(url, headers=headers), timeout=timeout) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read())

def api(route, allowed=(200,)):
    status, data = get(URL + route, token=True)
    if status not in allowed:
        raise RuntimeError('OpenRig query failed: ' + route)
    return data

def product_identity():
    status, projects = get('http://127.0.0.1:4310/api/projects')
    if status != 200:
        raise RuntimeError('Cannot read real Weiwu projects')
    project = next((item for item in projects if item['id'] == PROJECT), None)
    if not project or project['departmentId'] != DEPARTMENT:
        raise RuntimeError('Real project department no longer matches this deployment')
    status, departments = get('http://127.0.0.1:4310/api/departments')
    department = next((item for item in departments if item['id'] == DEPARTMENT), None)
    if status != 200 or not department:
        raise RuntimeError('Real department unavailable or archived')
    expected = {'mgr-1': 'manager', 'dev-1': 'member', 'qa-1': 'member'}
    if {a['id']: a['role'] for a in department['agents']} != expected:
        raise RuntimeError('Real department employee identities changed')
    plan = project['plan']['agents']
    for identity, role in expected.items():
        if not any(a['id'] == identity and a['role'] == role and (a.get('sourceDepartmentId') or DEPARTMENT) == DEPARTMENT and (a.get('sourceAgentId') or identity) == identity for a in plan):
            raise RuntimeError('Project employee provenance changed')
    return {'projectId': PROJECT, 'projectVersion': project['version'], 'departmentId': DEPARTMENT,
            'departmentVersion': department['version'], 'employeeIds': list(expected)}

def unit_text():
    return f'''[Unit]
Description=Weiwu optional OpenRig 0.6.6 metadata queue (no kernel)
StartLimitIntervalSec=120
StartLimitBurst=3

[Service]
Type=exec
WorkingDirectory={BASE}
ExecStart=/usr/bin/python3 {BASE}/admin/openrig-metadata-runner.py
UMask=0077
NoNewPrivileges=yes
Restart=on-failure
RestartSec=5
KillMode=mixed
KillSignal=SIGTERM
TimeoutStopSec=30
StandardOutput=journal
StandardError=journal
SyslogIdentifier=weiwu-openrig

[Install]
WantedBy=default.target
'''.encode()

def rig_spec():
    return {'name': RIG_NAME, 'version': '1.0', 'pods': [{'id': 'dev', 'label': 'Weiwu metadata seats', 'members': [
        {'id': member, 'label': employee + ' metadata seat', 'agent_ref': 'local:agent', 'profile': 'metadata',
         'runtime': 'stub', 'role': role, 'cwd': str(BASE / 'workspace')}
        for employee, (member, role) in EMPLOYEES.items()]}]}

def load_state():
    if not STATE.exists():
        return None
    runner.checked_path(STATE)
    state = json.loads(STATE.read_text())
    expected = {'schema': 1, 'owner': 'weiwu-openrig-metadata-v1', 'base': str(BASE), 'departmentId': DEPARTMENT, 'rigName': RIG_NAME, 'port': PORT}
    if any(state.get(key) != value for key, value in expected.items()):
        raise RuntimeError('Existing installation belongs to another deployment')
    return state

def matching_rig(rigs, attempted):
    matches = [rig for rig in rigs if rig.get('name') == RIG_NAME]
    if len(matches) > 1 or any(rig.get('name') != RIG_NAME for rig in rigs):
        raise RuntimeError('Unexpected rig topology in isolated metadata instance')
    if matches:
        return matches[0]
    if attempted:
        raise RuntimeError('Prior materialization is unresolved; query only, never repeat import')
    return None

def verify_topology(rig):
    if rig.get('name') != RIG_NAME:
        raise RuntimeError('Rig identity mismatch')
    nodes = api('/api/rigs/' + rig['id'] + '/nodes')
    if api('/api/rigs/' + rig['id'] + '/sessions') != []:
        raise RuntimeError('OpenRig sessions must remain empty')
    if len(nodes) != 3:
        raise RuntimeError('Expected exactly three metadata nodes')
    seats = []
    for employee, (member, role) in EMPLOYEES.items():
        found = [node for node in nodes if node.get('logicalId') == 'dev.' + member]
        if len(found) != 1 or found[0].get('role') != role or found[0].get('runtime') != 'stub' or found[0].get('sessionStatus') is not None or found[0].get('canonicalSessionName'):
            raise RuntimeError('Metadata node identity or session state changed')
        seats.append({'employeeId': employee, 'logicalId': 'dev.' + member, 'nodeId': found[0]['nodeId'], 'role': role})
    return seats

def verify_process_identity(service):
    pid = int(service.get('MainPID', '0'))
    if service.get('ActiveState') != 'active' or pid < 1:
        raise RuntimeError('Metadata service is not active')
    proc = Path('/proc') / str(pid)
    args = (proc / 'cmdline').read_bytes().split(b'\0')
    if args[:2] != [str(NODE).encode(), str(PACKAGE / 'daemon/dist/index.js').encode()]:
        raise RuntimeError('Service PID is not the pinned foreground daemon')
    environment = dict(item.split(b'=', 1) for item in (proc / 'environ').read_bytes().split(b'\0') if b'=' in item)
    if environment.get(b'OPENRIG_HOME') != str(BASE / 'state').encode() or environment.get(b'OPENRIG_DB') != str(BASE / 'state/openrig.sqlite').encode():
        raise RuntimeError('Service PID belongs to another OpenRig data directory')
    return pid, environment

def verify_process():
    pid, environment = verify_process_identity(show_service())
    expected = runner.clean_environment()
    if environment != {key.encode(): value.encode() for key, value in expected.items()}:
        raise RuntimeError('Daemon environment differs from isolated metadata environment')
    sockets = command(['ss', '-H', '-ltn']).stdout.splitlines()
    addresses = [line.split()[3] for line in sockets if len(line.split()) > 3 and line.split()[3].endswith(':' + str(PORT))]
    if addresses != ['127.0.0.1:' + str(PORT)]:
        raise RuntimeError('Daemon listener is not exclusively loopback')
    health = api('/healthz')
    if health.get('status') != 'ok' or health.get('semver') != '0.6.6' or not health.get('selfHostId'):
        raise RuntimeError('Daemon health identity mismatch')
    kernel = api('/api/kernel/status', (200, 503))
    if kernel.get('agents', []) != []:
        raise RuntimeError('Kernel agents must remain absent')
    return {'pid': pid, 'selfHostId': health['selfHostId'], 'noKernel': True, 'loopbackOnly': True, 'noProviderEnvironment': True}

def check():
    if sys.platform != 'linux' or os.getuid() == 0 or os.environ.get('USER') != 'jj':
        raise RuntimeError('Run as the existing unprivileged JJ user, never sudo')
    runner.checked_path(ROOT / 'data/pilot')
    runner.checked_path(BASE, exists=False)
    runner.checked_path(UNIT, exists=False)
    runner.runtime_check()
    if command([str(NODE), '--version'], environment={'PATH': '/usr/bin:/bin'}).stdout.strip() != 'v24.19.0':
        raise RuntimeError('Pinned Node version mismatch')
    state = load_state()
    service = show_service()
    if BASE.exists() and not state:
        raise RuntimeError('Existing data without an ownership manifest; preserve and inspect')
    if UNIT.exists() and UNIT.read_bytes() != unit_text():
        raise RuntimeError('Existing unit differs; refusing replacement')
    if service.get('LoadState') != 'not-found' and service.get('FragmentPath') != str(UNIT):
        raise RuntimeError('A different service owns this unit name')
    if listening() and service.get('ActiveState') != 'active':
        raise RuntimeError('Port already used by a process outside this service')
    result = {'readOnly': True, 'runtimePinned': True, 'identity': product_identity(), 'port': PORT,
              'dataExists': BASE.exists(), 'service': service, 'weiwuService': show_service('weiwu-jj.service'),
              'configPath': str(BASE / 'bridge-config.json'), 'modelCalls': 0, 'queueWrites': 0}
    if service.get('ActiveState') == 'active':
        result['daemon'] = verify_process()
    return result

def apply():
    global REPORT
    before = check()
    os.umask(0o077)
    state = load_state()
    if state is None:
        BASE.mkdir(mode=0o700)
        state = {'schema': 1, 'owner': 'weiwu-openrig-metadata-v1', 'base': str(BASE), 'departmentId': DEPARTMENT,
                 'rigName': RIG_NAME, 'port': PORT, 'materializationAttempted': False, 'createdAt': now()}
        write_sync(STATE, content(state), exclusive=True)
    for name in ['home', 'state', 'tmp', 'workspace', 'mapping', 'agent', 'admin', 'evidence']:
        target = runner.checked_path(BASE / name, exists=False)
        target.mkdir(mode=0o700, exist_ok=True)
    REPORT = {'kind': 'openrig-metadata-deployment', 'startedAt': now(), 'status': 'preparing', 'precheck': before,
              'evidence': str(BASE / 'evidence' / ('deployment-' + str(uuid.uuid4()) + '.json')), 'steps': [], 'modelCallsRequested': 0, 'queueWritesRequested': 0}
    save_report()
    token = BASE / 'terminal-token'
    if not token.exists():
        if state.get('tokenCreated'):
            raise RuntimeError('Existing token disappeared; never regenerate an established identity')
        write_sync(token, (secrets.token_urlsafe(48) + '\n').encode(), exclusive=True)
    runner.clean_environment()
    state['tokenCreated'] = True
    write_sync(STATE, content(state))
    immutable(BASE / 'admin/openrig-metadata-runner.py', (HERE / 'openrig-metadata-runner.py').read_bytes())
    immutable(BASE / 'agent/agent.yaml', b'name: weiwu-metadata-only\nversion: "1.0"\nprofiles:\n  metadata: {}\n')
    immutable(BASE / 'rig.yaml', content(rig_spec()))
    staged_unit = BASE / 'admin' / SERVICE
    immutable(staged_unit, unit_text())
    command(['systemd-analyze', '--user', 'verify', str(staged_unit)])
    immutable(UNIT, unit_text())
    command(['systemctl', '--user', 'daemon-reload'])
    command(['systemctl', '--user', 'enable', '--now', SERVICE], timeout=30)
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        try:
            status, health = get(URL + '/healthz', token=True, timeout=2)
            if status == 200 and health.get('status') == 'ok':
                break
        except (RuntimeError, OSError, urllib.error.URLError):
            pass
        time.sleep(0.5)
    else:
        raise RuntimeError('Daemon readiness not confirmed; retain service and inspect evidence')
    process = verify_process()
    rigs = api('/api/rigs')
    rig = matching_rig(rigs, state['materializationAttempted'])
    if rig is None:
        command([str(NODE), str(PACKAGE / 'dist/bin-wrapper.js'), 'spec', 'validate', str(BASE / 'rig.yaml')], runner.clean_environment())
        state['materializationAttempted'] = True
        state['materializationStartedAt'] = now()
        write_sync(STATE, content(state))
        command([str(NODE), str(PACKAGE / 'dist/bin-wrapper.js'), 'import', str(BASE / 'rig.yaml'), '--materialize-only',
                 '--rig-root', str(BASE), '--cwd', str(BASE / 'workspace')], runner.clean_environment(), timeout=60)
        rig = matching_rig(api('/api/rigs'), True)
    seats = verify_topology(rig)
    if state.get('rigId') and state['rigId'] != rig['id']:
        raise RuntimeError('Established rig identity changed')
    config = {'schema': 1, 'enabled': True, 'bridge': {'version': '0.6.6', 'endpoint': URL,
              'expectedSelfHostId': process['selfHostId'], 'tokenFile': str(token), 'stateDirectory': str(BASE / 'mapping')},
              'departments': [{'departmentId': DEPARTMENT, 'rigId': rig['id'], 'rigName': RIG_NAME, 'seats': seats,
                               'sourceEmployeeId': 'mgr-1', 'destinationEmployeeId': 'dev-1'}]}
    immutable(BASE / 'bridge-config.json', content(config))
    state.update({'rigId': rig['id'], 'seats': seats, 'selfHostId': process['selfHostId'], 'configuredAt': now()})
    write_sync(STATE, content(state))
    REPORT.update({'status': 'passed', 'process': verify_process(), 'rigId': rig['id'], 'seats': seats,
                   'weiwuServiceAfter': show_service('weiwu-jj.service'), 'configPath': str(BASE / 'bridge-config.json')})
    save_report()
    return {key: REPORT[key] for key in ['status', 'evidence', 'process', 'rigId', 'configPath', 'modelCallsRequested', 'queueWritesRequested']}

def rollback():
    # Keep all state/token/config/database and the owned unit file. Disable only
    # this service. A later explicit apply can re-enable and query original IDs.
    if sys.platform != 'linux' or os.getuid() == 0 or os.environ.get('USER') != 'jj':
        raise RuntimeError('Run as the existing unprivileged JJ user, never sudo')
    if not load_state() or not UNIT.exists() or UNIT.read_bytes() != unit_text():
        raise RuntimeError('Cannot prove ownership of service; no stop requested')
    runner.checked_path(UNIT)
    service = show_service()
    if service.get('FragmentPath') != str(UNIT):
        raise RuntimeError('Unexpected service owner; no stop requested')
    pid = int(service.get('MainPID', '0'))
    if pid:
        # An unhealthy owned daemon can still be stopped safely. HTTP health
        # failure must not prevent rollback; verify its actual PID/data identity.
        verify_process_identity(service)
    command(['systemctl', '--user', 'disable', '--now', SERVICE], timeout=40)
    after = show_service()
    if int(after.get('MainPID', '0')) or listening():
        raise RuntimeError('Shutdown not confirmed; no data has been removed')
    clean = None
    if pid:
        receipt = json.loads(runner.checked_path(BASE / 'state/daemon-shutdown.json').read_text())
        clean = receipt.get('schema') == 'openrig.daemon-shutdown/v1' and receipt.get('pid') == pid and receipt.get('outcome') == 'clean'
        if not clean:
            raise RuntimeError('Service stopped but clean daemon drain not confirmed; retain receipt')
    return {'status': 'disabled', 'preservedData': str(BASE), 'serviceStopped': True, 'cleanDrain': clean, 'modelCallsRequested': 0, 'queueWritesRequested': 0}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('--check', action='store_true', help='Read-only preflight (default)')
    modes.add_argument('--apply', action='store_true', help='Explicitly install/enable metadata service and bind the existing department')
    modes.add_argument('--rollback', action='store_true', help='Disable only the owned metadata service; preserve all data')
    args = parser.parse_args()
    try:
        result = apply() if args.apply else rollback() if args.rollback else check()
        print(json.dumps(result, ensure_ascii=False))
    except Exception as error:
        if REPORT is not None:
            REPORT.update({'status': 'failed', 'errorType': type(error).__name__, 'error': str(error)})
            save_report()
        print(json.dumps({'status': 'stopped', 'reason': str(error), 'evidence': REPORT['evidence'] if REPORT else None,
                          'modelCallsRequested': 0, 'queueWritesRequested': 0}, ensure_ascii=False))
        sys.exit(1)

if __name__ == '__main__':
    main()

"""Local fault-injection guards only; no Docker/network/OpenShell requests.

These checks verify the administrator helper's refusal/restoration behavior.
They are not sandbox acceptance evidence.
"""
import contextlib
import copy
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('preload', Path(__file__).with_name('preload-node-proxy.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def gateway():
    return {'Id': 'a' * 64, 'ImageId': 'sha256:' + 'b' * 64, 'Image': module.GATEWAY_IMAGE,
            'Path': '/usr/local/bin/openshell-gateway', 'Args': ['--bind-address', '0.0.0.0', '--port', '18770'],
            'Running': True, 'Restart': 'unless-stopped',
            'Labels': {'com.docker.compose.project': module.PROJECT, 'com.docker.compose.service': 'gateway'},
            'Ports': {'18770/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '18770'}],
                      '18771/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '18771'}]}}


class FakePreloader(module.Preloader):
    def __init__(self, state, fault=None, cached=False):
        super().__init__()
        self.gateway = gateway()
        self.actual = copy.deepcopy(self.gateway)
        self.original_unit = {'ActiveState': 'active', 'FragmentPath': '/usr/lib/systemd/system/docker.service',
                              'Environment': '', 'EnvironmentFiles': '', 'ExecStart': 'dockerd --host=fd://', 'DropInPaths': ''}
        self.original_protected = {'tls/key': 'private-sha-only'}
        self.actions = []
        self.fault = fault
        self.cached = cached
        self.state = state
        self.loaded_proxy = False
        self.process_proxy = False
        self.report_data = {'schema': 1, 'image': module.NODE_IMAGE, 'proxy': module.PROXY,
                            'gatewayContainerId': self.gateway['Id'], 'originalGateway': self.gateway,
                            'originalUnit': self.original_unit, 'protectedSha256': self.original_protected,
                            'alreadyCached': cached, 'sandboxOperations': 0, 'modelCalls': 0}

    def inventory(self):
        return [copy.deepcopy(self.actual)]

    def unit(self):
        unit = dict(self.original_unit)
        if self.loaded_proxy:
            unit['Environment'] = 'HTTP_PROXY=http://127.0.0.1:7897 HTTPS_PROXY=http://127.0.0.1:7897'
            unit['DropInPaths'] = str(module.DROPIN)
        return unit

    def node(self):
        return {'config': module.NODE_CONFIG} if self.cached else None

    def wait_docker(self):
        pass

    def run(self, args, **kwargs):
        self.actions.append(tuple(args))
        if args == ['systemctl', 'daemon-reload']:
            self.loaded_proxy = module.DROPIN.exists()
        if args == ['systemctl', 'restart', 'docker.service']:
            self.process_proxy = self.loaded_proxy
        return subprocess.CompletedProcess(args, 0, '', '')

    def daemon_environment(self):
        module.no_proxy_environment(b'PATH=/usr/bin\0HTTPS_PROXY=http://127.0.0.1:7897\0' if self.process_proxy else b'PATH=/usr/bin\0')
        return {'mainPid': 2008899, 'proxyVariableNames': []}

    def docker(self, *args, **kwargs):
        self.actions.append(tuple(args))
        if args[0] == 'stop':
            self.actual['Running'] = False
        elif args[0] == 'start':
            self.actual['Running'] = True
        elif args[:2] == ('image', 'pull'):
            if self.fault == 'pull-timeout':
                raise subprocess.TimeoutExpired(['docker', 'image', 'pull'], 600)
            if self.fault == 'pull-failure':
                return subprocess.CompletedProcess(args, 1, '', 'network refused')
            self.cached = True
            if self.fault == 'db-change':
                (self.state / 'gateway.db').write_bytes(b'concurrent DB edit')
            if self.fault == 'proxy-change':
                module.DROPIN.write_bytes(b'[Service]\nEnvironment="HTTPS_PROXY=another-admin"\n')
        return subprocess.CompletedProcess(args, 0, '', '')


class PreloadTests(unittest.TestCase):
    def setup_worker(self, directory, **kwargs):
        state = Path(directory) / 'state'
        state.mkdir()
        (state / 'gateway.db').write_bytes(b'realistic opaque SQLite bytes fixture')
        (state / 'gateway.db-wal').write_bytes(b'opaque WAL fixture')
        worker = FakePreloader(state, **kwargs)
        stack = contextlib.ExitStack()
        stack.enter_context(patch.object(module, 'STATE', state))
        stack.enter_context(patch.object(module, 'DROPIN', Path(directory) / 'run' / 'proxy.conf'))
        stack.enter_context(patch.object(module, 'canonical', side_effect=lambda path, **kwargs: Path(path)))
        stack.enter_context(patch.object(module, 'protected_manifest', return_value=worker.original_protected))
        stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
        return worker, stack

    def test_cached_image_does_not_stop_gateway_or_restart_docker(self):
        with tempfile.TemporaryDirectory() as directory:
            worker, stack = self.setup_worker(directory, cached=True)
            with stack:
                worker.apply()
            self.assertEqual(worker.actions, [])

    def test_success_pulls_once_restores_proxy_and_same_gateway(self):
        with tempfile.TemporaryDirectory() as directory:
            worker, stack = self.setup_worker(directory)
            with stack:
                worker.apply()
                self.assertFalse(module.DROPIN.exists())
                self.assertTrue(worker.actual['Running'])
                report = json.loads(worker.report.read_text())
                self.assertTrue(report['proxyRestored'])
                self.assertTrue(report['gatewayRestored'])
                self.assertTrue(report['preloadPassed'])
                self.assertEqual(report['pullAttemptCount'], 1)
                self.assertEqual((worker.report.parent / 'gateway.db.stopped.backup').read_bytes(),
                                 (worker.state / 'gateway.db').read_bytes())
                self.assertEqual((worker.report.parent / 'gateway.db-wal.stopped.backup').read_bytes(),
                                 (worker.state / 'gateway.db-wal').read_bytes())
            self.assertEqual(sum(action[:2] == ('image', 'pull') for action in worker.actions), 1)
            self.assertEqual(sum(action == ('systemctl', 'restart', 'docker.service') for action in worker.actions), 2)
            self.assertIn(('start', gateway()['Id']), worker.actions)
            self.assertFalse(any('create' in action or 'compose' in action for action in worker.actions))

    def test_failed_pull_and_timeout_restore_without_retry(self):
        for fault in ('pull-failure', 'pull-timeout'):
            with self.subTest(fault=fault), tempfile.TemporaryDirectory() as directory:
                worker, stack = self.setup_worker(directory, fault=fault)
                with stack:
                    with self.assertRaises((RuntimeError, subprocess.TimeoutExpired)):
                        worker.apply()
                    self.assertFalse(module.DROPIN.exists())
                    self.assertTrue(worker.actual['Running'])
                    report = json.loads(worker.report.read_text())
                    self.assertFalse(report['preloadPassed'])
                    self.assertTrue(report['proxyRestored'])
                    self.assertEqual(report['pullAttemptCount'], 1)
                self.assertEqual(sum(action[:2] == ('image', 'pull') for action in worker.actions), 1)

    def test_database_edit_never_overwrites_backup_or_starts_gateway(self):
        with tempfile.TemporaryDirectory() as directory:
            worker, stack = self.setup_worker(directory, fault='db-change')
            with stack:
                with self.assertRaisesRegex(RuntimeError, 'Rollback needs administrator'):
                    worker.apply()
                self.assertFalse(worker.actual['Running'])
                self.assertFalse(module.DROPIN.exists())
                self.assertNotEqual((worker.report.parent / 'gateway.db.stopped.backup').read_bytes(),
                                    (worker.state / 'gateway.db').read_bytes())
                self.assertTrue(json.loads(worker.report.read_text())['rollbackErrors'])

    def test_another_admin_proxy_edit_is_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            worker, stack = self.setup_worker(directory, fault='proxy-change')
            with stack:
                with self.assertRaisesRegex(RuntimeError, 'Rollback needs administrator'):
                    worker.apply()
                self.assertIn(b'another-admin', module.DROPIN.read_bytes())
                self.assertFalse(worker.actual['Running'])

    def test_refuses_other_containers_and_changed_gateway(self):
        original = gateway()
        module.verify_gateway([original])
        for records in ([original, {**original, 'Id': 'stranger', 'Running': False}],
                        [{**original, 'Args': ['--port', '8080']}],
                        [{**original, 'Ports': {}}]):
            with self.assertRaises(RuntimeError):
                module.verify_gateway(records)

    def test_digest_tag_or_platform_mismatch_is_rejected(self):
        metadata = {'Id': module.NODE_CONFIG, 'Os': 'linux', 'Architecture': 'amd64',
                    'RepoDigests': ['node@' + module.NODE_IMAGE.rsplit('@', 1)[1]]}
        module.verify_node(metadata)
        for changed in ({'Id': 'sha256:wrong'}, {'RepoDigests': ['node:24.19.0']}, {'Architecture': 'arm64'}):
            with self.assertRaises(RuntimeError):
                module.verify_node({**metadata, **changed})

    def test_actual_docker29_containerd_manifest_identity_and_classic_config(self):
        actual = {'Id': 'sha256:e5a8dee7bc1e6a215d224a7ef8206f7e77271bc3cabd5febf2beafac0674f174',
                  'Os': 'linux', 'Architecture': 'amd64',
                  'RepoDigests': ['node@sha256:e5a8dee7bc1e6a215d224a7ef8206f7e77271bc3cabd5febf2beafac0674f174']}
        result = module.verify_node(actual)
        self.assertEqual(result['identityKind'], 'manifest')
        self.assertEqual(result['imageId'], actual['Id'])
        self.assertNotIn('config', result)
        classic = module.verify_node({**actual, 'Id': module.NODE_CONFIG})
        self.assertEqual(classic['identityKind'], 'config')
        for changed in ({'Id': 'sha256:' + '0' * 64}, {'RepoDigests': ['node@sha256:' + '0' * 64]}, {'Architecture': 'arm64'}):
            with self.assertRaises(RuntimeError):
                module.verify_node({**actual, **changed})

    def test_real_systemctl_execstart_runtime_fields_do_not_change_config(self):
        original = {'ActiveState': 'active', 'FragmentPath': '/usr/lib/systemd/system/docker.service',
                    'DropInPaths': '', 'Environment': '', 'EnvironmentFiles': '',
                    'ExecStart': '{ path=/usr/bin/dockerd ; argv[]=/usr/bin/dockerd -H fd:// --containerd=/run/containerd/containerd.sock ; ignore_errors=no ; start_time=[Thu 2026-10-08 20:01:33 CST] ; stop_time=[n/a] ; pid=1615819 ; code=(null) ; status=0/0 }'}
        current = {**original, 'ExecStart': '{ path=/usr/bin/dockerd ; argv[]=/usr/bin/dockerd -H fd:// --containerd=/run/containerd/containerd.sock ; ignore_errors=no ; start_time=[Thu 2026-10-08 21:55:06 CST] ; stop_time=[Thu 2026-10-08 21:54:45 CST] ; pid=2008899 ; code=exited ; status=0/SUCCESS }'}
        self.assertNotEqual(original, current)
        self.assertEqual(module.static_unit(original), module.static_unit(current))
        for changed in ('--containerd=/run/other/containerd.sock', '--https-proxy=http://127.0.0.1:7897'):
            different = {**current, 'ExecStart': current['ExecStart'].replace('--containerd=/run/containerd/containerd.sock', changed)}
            self.assertNotEqual(module.static_unit(original), module.static_unit(different))
        self.assertNotEqual(module.static_unit(original), module.static_unit({**current, 'Environment': 'HTTPS_PROXY=http://127.0.0.1:7897'}))

    def test_live_environment_rejects_proxy_even_if_unit_metadata_is_clean(self):
        module.no_proxy_environment(b'PATH=/usr/bin\0HOME=/root\0')
        for name in (b'HTTPS_PROXY', b'http_proxy', b'NO_PROXY', b'ALL_PROXY'):
            with self.assertRaisesRegex(RuntimeError, 'Actual dockerd'):
                module.no_proxy_environment(b'PATH=/usr/bin\0' + name + b'=http://127.0.0.1:7897\0')

    def test_old_report_recovery_skips_completed_restart_and_keeps_source_report(self):
        with tempfile.TemporaryDirectory() as directory:
            worker, stack = self.setup_worker(directory)
            with stack:
                worker.apply()
                source = worker.report
                data = json.loads(source.read_text())
                data['proxyRestored'] = False
                data['gatewayRestored'] = False
                data['rollbackErrors'] = ['Docker system unit/environment did not restore exactly.']
                source.write_text(json.dumps(data))
                source_bytes = source.read_bytes()
                recovered = FakePreloader(worker.state)
                recovered.actual['Running'] = False
                recovered.original_unit['ExecStart'] = worker.original_unit['ExecStart']
                with patch.object(module, 'Preloader', return_value=recovered), patch.object(module.os, 'geteuid', return_value=0, create=True):
                    module.rollback(str(source.parent))
                self.assertEqual(source.read_bytes(), source_bytes)
                self.assertTrue(recovered.actual['Running'])
                self.assertEqual(recovered.actions, [('start', worker.gateway['Id'])])
                self.assertNotEqual(recovered.report, source)
                self.assertTrue(json.loads(recovered.report.read_text())['skippedAlreadyCompletedDaemonRestart'])


if __name__ == '__main__':
    unittest.main(verbosity=2)

"""Isolated deployment guards; no systemd mutation, daemon or model startup."""
from pathlib import Path
from unittest import mock
import contextlib
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('deploy', HERE / 'prepare-jj-openrig.py')
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)

@contextlib.contextmanager
def owned_directory():
    parent = (Path.cwd() / '.openrig-deployment-test').resolve()
    parent.mkdir(exist_ok=True)
    directory = Path(tempfile.mkdtemp(prefix='case-', dir=parent)).resolve()
    try:
        yield directory
    finally:
        assert directory.parent == parent and directory.name.startswith('case-')
        shutil.rmtree(directory)
        if not any(parent.iterdir()):
            parent.rmdir()

class DeploymentGuards(unittest.TestCase):
    def test_unknown_materialization_cannot_import_again(self):
        self.assertIsNone(deploy.matching_rig([], False))
        with self.assertRaisesRegex(RuntimeError, 'never repeat import'):
            deploy.matching_rig([], True)

    def test_reconcile_existing_rig_and_reject_foreign_or_duplicate_topology(self):
        existing = {'id': 'original-rig', 'name': deploy.RIG_NAME}
        self.assertEqual(deploy.matching_rig([existing], True), existing)
        for rows in [[existing, existing], [{'id': 'foreign', 'name': 'another-rig'}]]:
            with self.assertRaises(RuntimeError):
                deploy.matching_rig(rows, True)

    @unittest.skipUnless(os.name == 'posix', 'fsync directory and Unix permissions tested on JJ Linux')
    def test_owned_config_never_silently_overwrites_changes(self):
        with owned_directory() as directory:
            file = directory / 'owned-config'
            deploy.immutable(file, b'original')
            deploy.immutable(file, b'original')
            with self.assertRaises(RuntimeError):
                deploy.immutable(file, b'replacement')
            self.assertEqual(file.read_bytes(), b'original')
            self.assertEqual(file.stat().st_mode & 0o077, 0)

    @unittest.skipUnless(os.name == 'posix', 'private environment uses Unix ownership')
    def test_runner_environment_drops_all_provider_credentials_and_proxy(self):
        with owned_directory() as directory, mock.patch.object(deploy.runner, 'BASE', directory):
            token = directory / 'terminal-token'
            token.write_text('A' * 64)
            token.chmod(0o600)
            with mock.patch.dict(os.environ, {'OPENAI_API_KEY': 'must-not-pass', 'ANTHROPIC_API_KEY': 'must-not-pass', 'HTTP_PROXY': 'must-not-pass', 'OPENRIG_NO_KERNEL': '0'}):
                environment = deploy.runner.clean_environment()
            self.assertEqual(environment['OPENRIG_NO_KERNEL'], '1')
            self.assertEqual(environment['OPENRIG_BIND_HOST'], '127.0.0.1')
            self.assertEqual(environment['HOME'], str(directory / 'home'))
            self.assertFalse(any('must-not-pass' in value for value in environment.values()))
            self.assertFalse(any(name.endswith(('API_KEY', 'ACCESS_TOKEN')) for name in environment))

    def test_existing_foreign_installation_is_not_adopted(self):
        with owned_directory() as directory:
            state = directory / 'installation.json'
            state.write_text(json.dumps({'schema': 1, 'owner': 'foreign'}))
            with mock.patch.object(deploy, 'STATE', state), self.assertRaises(RuntimeError):
                deploy.load_state()

    def test_node_sessions_and_runtime_are_verified_before_config_publication(self):
        nodes = [{'logicalId': 'dev.' + member, 'nodeId': member + '-id', 'role': role, 'runtime': 'stub', 'sessionStatus': None, 'canonicalSessionName': None}
                 for member, role in deploy.EMPLOYEES.values()]
        rig = {'id': 'rig', 'name': deploy.RIG_NAME}
        def api(route):
            return [] if route.endswith('/sessions') else nodes
        with mock.patch.object(deploy, 'api', api):
            self.assertEqual([seat['employeeId'] for seat in deploy.verify_topology(rig)], ['mgr-1', 'dev-1', 'qa-1'])
            nodes[1]['runtime'] = 'codex'
            with self.assertRaises(RuntimeError):
                deploy.verify_topology(rig)
            nodes[1]['runtime'] = 'stub'
            nodes[1]['sessionStatus'] = 'running'
            with self.assertRaises(RuntimeError):
                deploy.verify_topology(rig)

    def test_rollback_refuses_changed_unit_without_signaling_anything(self):
        with owned_directory() as directory:
            unit = directory / 'weiwu-openrig.service'
            unit.write_bytes(b'foreign changed service')
            with mock.patch.object(deploy, 'UNIT', unit), mock.patch.object(deploy, 'load_state', return_value={'owner': 'known'}), \
                 mock.patch.object(deploy.sys, 'platform', 'linux'), mock.patch.object(deploy.os, 'getuid', return_value=1000, create=True), \
                 mock.patch.dict(deploy.os.environ, {'USER': 'jj'}), mock.patch.object(deploy, 'command') as command:
                with self.assertRaises(RuntimeError):
                    deploy.rollback()
                command.assert_not_called()

if __name__ == '__main__':
    unittest.main(verbosity=2)

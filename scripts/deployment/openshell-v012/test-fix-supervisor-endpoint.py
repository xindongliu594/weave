"""Local helper guards; never accesses Docker, OpenShell, SSH or model APIs."""
import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('endpoint_fix', Path(__file__).with_name('fix-supervisor-endpoint.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def gateway():
    return {'Id': 'original-gateway', 'Image': module.GATEWAY_IMAGE, 'Running': True,
            'Path': '/usr/local/bin/openshell-gateway', 'Args': ['--bind-address', '0.0.0.0', '--port', '18770'],
            'Labels': {'com.docker.compose.project': module.PROJECT, 'com.docker.compose.service': 'gateway'},
            'Ports': {'18770/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '18770'}],
                      '18771/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '18771'}]},
            'Mounts': [{'Type': 'bind', 'Destination': '/etc/openshell/gateway.toml', 'Source': str(module.CONFIG), 'RW': False}]}


class EndpointTests(unittest.TestCase):
    def test_unique_patch_preserves_all_other_fields_and_rejects_changed_sha(self):
        original = b'# existing comments retained\n[openshell.drivers.docker]\ngrpc_endpoint = "https://host.openshell.internal:18770"\nimage_pull_policy = "if_not_present"\n'
        with patch.object(module, 'OLD_SHA', hashlib.sha256(original).hexdigest()):
            candidate = module.patch_bytes(original)
            self.assertEqual(candidate, original.replace(module.OLD_LINE, module.NEW_LINE))
            self.assertIn(b'# existing comments retained', candidate)
            with self.assertRaisesRegex(RuntimeError, 'exact reviewed'):
                module.patch_bytes(original + b'# someone else edited\n')

    def test_bind_mount_update_preserves_inode_and_cas_refuses_concurrent_edit(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'gateway.toml'
            original = module.OLD_LINE + b'\n'
            candidate = module.NEW_LINE + b'\n'
            path.write_bytes(original)
            inode = path.stat().st_ino
            with patch.object(module, 'canonical', side_effect=lambda value: Path(value)):
                module.rewrite_in_place(path, original, candidate)
                self.assertEqual(path.stat().st_ino, inode)
                self.assertEqual(path.read_bytes(), candidate)
                with self.assertRaisesRegex(RuntimeError, 'changed before update'):
                    module.rewrite_in_place(path, original, candidate)
                self.assertEqual(path.read_bytes(), candidate)
                module.rewrite_in_place(path, candidate, original)
                self.assertEqual(path.stat().st_ino, inode)
                self.assertEqual(path.read_bytes(), original)

    def test_cleaned_failure_allowed_but_active_employee_and_changed_gateway_rejected(self):
        expected = gateway()
        actual, residual = module.check_inventory([expected])
        self.assertEqual(actual, expected)
        self.assertEqual(residual, [])  # Absence is not fabricated inspection evidence.
        with self.assertRaisesRegex(RuntimeError, 'active'):
            module.check_inventory([expected, {'Id': 'employee', 'Running': True, 'Labels': {}}])
        with self.assertRaises(RuntimeError):
            module.check_inventory([{**expected, 'Args': ['--port', '8080']}])

    def test_residual_supervisor_host_and_workload_none_are_strict(self):
        labels = {'openshell.ai/managed-by': 'openshell', 'openshell.ai/sandbox-id': module.FAILED_ID,
                  'openshell.ai/sandbox-name': module.FAILED_NAME, 'openshell.ai/sandbox-namespace': module.PROJECT}
        supervisor = {'Id': 'stopped-supervisor', 'Running': False, 'Labels': {**labels, 'openshell.ai/isolation-role': 'supervisor'},
                      'Network': 'host', 'ExtraHosts': None}
        workload = {'Id': 'stopped-workload', 'Running': False, 'Labels': {**labels, 'openshell.ai/isolation-role': 'sandbox'},
                    'Network': 'none', 'ExtraHosts': None}
        _, residual = module.check_inventory([gateway(), supervisor, workload])
        self.assertEqual(len(residual), 2)
        for changed in ({**supervisor, 'Network': 'bridge'}, {**supervisor, 'ExtraHosts': ['host.openshell.internal:127.0.0.1']},
                        {**workload, 'Network': 'host'}):
            with self.assertRaises(RuntimeError):
                module.check_inventory([gateway(), changed])


if __name__ == '__main__':
    unittest.main(verbosity=2)

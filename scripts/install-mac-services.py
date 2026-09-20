#!/usr/bin/env python3
"""Install per-user launchd services. Run after stopping the development API."""
import os
import pathlib
import plistlib
import shutil
import subprocess

root = pathlib.Path(__file__).resolve().parent.parent
node = shutil.which('node')
if not node:
    raise SystemExit('Put Node 22.19+ on PATH first')
origin = os.environ.get('ALLOWED_ORIGINS')
if not origin:
    raise SystemExit('Set ALLOWED_ORIGINS to the public HTTPS origin first')
# launchd cannot read Desktop/Documents under macOS privacy protection.
# Install a runtime copy and keep the source checkout linked to the same data.
runtime = pathlib.Path.home() / 'Library' / 'Application Support' / 'AgentDepartment'
runtime.mkdir(mode=0o700, parents=True, exist_ok=True)
for name in ['api', 'tunnel']:
    subprocess.run(['launchctl', 'bootout', f'gui/{os.getuid()}/com.agent-department.{name}'], capture_output=True)
for directory in ['apps/api', 'packages', 'services', 'node_modules', 'scripts', 'infra']:
    (runtime / directory).mkdir(parents=True, exist_ok=True)
    # Synchronize only installed code directories, never the shared .data.
    # rsync updates existing npm symlinks correctly on repeated installs.
    subprocess.run(['/usr/bin/rsync', '-a', '--delete', str(root / directory) + '/', str(runtime / directory) + '/'], check=True)
shutil.copy2(root / 'package.json', runtime / 'package.json')
bin_dir = runtime / 'bin'
bin_dir.mkdir(exist_ok=True)
shutil.copy2(node, bin_dir / 'node')
data = runtime / '.data'
source_data = root / '.data'
if not source_data.is_symlink():
    if data.exists():
        raise SystemExit('Both source and installed data exist; refusing to overwrite either')
    if source_data.exists():
        shutil.move(str(source_data), str(data))
    else:
        data.mkdir(mode=0o700)
    source_data.symlink_to(data, target_is_directory=True)
elif source_data.resolve() != data:
    raise SystemExit('Source data points elsewhere; inspect before installing')
logs = data / 'deployment'
logs.mkdir(mode=0o700, parents=True, exist_ok=True)
agents = pathlib.Path.home() / 'Library' / 'LaunchAgents'
agents.mkdir(parents=True, exist_ok=True)
for name, script in [('api', 'server-api.sh'), ('tunnel', 'server-tunnel.sh')]:
    label = f'com.agent-department.{name}'
    path = agents / f'{label}.plist'
    spec = {
        'Label': label,
        'ProgramArguments': ['/bin/bash', str(runtime / 'scripts' / script)],
        'WorkingDirectory': str(runtime),
        'RunAtLoad': True,
        'KeepAlive': True,
        'ThrottleInterval': 15,
        'EnvironmentVariables': {
            'PATH': f'{bin_dir}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
            'ALLOWED_ORIGINS': origin,
            'AGENT_SSH_HOST': os.environ.get('AGENT_SSH_HOST', 'ai-mortgage-server'),
            'OBSIDIAN_VAULT': os.environ.get('OBSIDIAN_VAULT', str(runtime / '.data' / 'obsidian-vault')),
        },
        'StandardOutPath': str(logs / f'{name}.log'),
        'StandardErrorPath': str(logs / f'{name}.error.log'),
    }
    with path.open('wb') as output:
        plistlib.dump(spec, output)
    os.chmod(path, 0o600)
    target = f'gui/{os.getuid()}/{label}'
    subprocess.run(['launchctl', 'bootout', target], capture_output=True)
    subprocess.run(['launchctl', 'bootstrap', f'gui/{os.getuid()}', str(path)], check=True)
    print(f'Installed {label}')

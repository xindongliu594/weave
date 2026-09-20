#!/usr/bin/env python3
"""Publish only generated desktop installers and their SHA256 manifest."""
from pathlib import Path
import hashlib,json,subprocess
root=Path(__file__).resolve().parent.parent
version=json.loads((root/'apps/desktop/package.json').read_text())['version']
names=[f'Agent-Department-{version}-{target}' for target in ['win-x64.exe','win-x64.zip','mac-arm64.dmg','mac-x64.dmg']]
files=[root/'dist/desktop'/name for name in names]
if any(not f.is_file() for f in files):raise SystemExit('Build all desktop targets first')
manifest=root/'dist/desktop/SHA256SUMS.txt'
manifest.write_text(''.join(hashlib.sha256(f.read_bytes()).hexdigest()+'  '+f.name+'\n' for f in files))
ssh=['ssh','-o','BatchMode=yes','-o','ConnectTimeout=10','ai-mortgage-server']
subprocess.run(ssh+['mkdir -p /opt/agent-department/web/downloads'],check=True)
subprocess.run(['scp','-o','BatchMode=yes','-o','ConnectTimeout=10',*[str(f)for f in files],str(manifest),'ai-mortgage-server:/opt/agent-department/web/downloads/'],check=True)
subprocess.run(ssh+['cd /opt/agent-department/web/downloads && chmod 644 *.exe *.zip *.dmg SHA256SUMS.txt && sha256sum -c SHA256SUMS.txt'],check=True)

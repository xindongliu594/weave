#!/usr/bin/env python3
"""Deploy the built frontend to the existing AI-Mortgage host over SSH."""
import io
import pathlib
import subprocess
import tarfile

root = pathlib.Path(__file__).resolve().parent.parent
ssh = ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'ai-mortgage-server']
archive = io.BytesIO()
with tarfile.open(fileobj=archive, mode='w:gz') as bundle:
    bundle.add(root / 'dist/web', arcname='web')
    bundle.add(root / 'infra/deployment/nginx.conf', arcname='nginx.conf')
    bundle.add(root / 'infra/deployment/edge-location.conf', arcname='edge-location.conf')
    bundle.add(root / 'infra/deployment/agent-department-web.service', arcname='agent-department-web.service')
    bundle.add(root / '.data/deployment/agent.htpasswd', arcname='agent.htpasswd')
subprocess.run(ssh + ['mkdir -p /opt/agent-department/run && tar xzf - -C /opt/agent-department'], input=archive.getvalue(), check=True)
remote = r'''
set -eu
cd /opt/agent-department
chmod 755 run web
chown root:101 agent.htpasswd
chmod 640 agent.htpasswd
podman run --rm --network docker_default \
  -v /opt/agent-department/nginx.conf:/etc/nginx/nginx.conf:ro \
  -v /opt/agent-department/web:/usr/share/nginx/html:ro \
  -v /opt/agent-department/agent.htpasswd:/etc/nginx/agent.htpasswd:ro \
  -v /opt/agent-department/run:/run/agent-department:ro \
  nginx:1.27-alpine nginx -t
if podman container exists agent-department-web; then
  podman exec agent-department-web nginx -t
  podman exec agent-department-web nginx -s reload
else
  podman run -d --name agent-department-web --restart unless-stopped \
    --network docker_default --network-alias agent-department-web \
    -v /opt/agent-department/nginx.conf:/etc/nginx/nginx.conf:ro \
    -v /opt/agent-department/web:/usr/share/nginx/html:ro \
    -v /opt/agent-department/agent.htpasswd:/etc/nginx/agent.htpasswd:ro \
    -v /opt/agent-department/run:/run/agent-department:ro \
    nginx:1.27-alpine
fi
install -m 644 agent-department-web.service /etc/systemd/system/agent-department-web.service
systemctl daemon-reload
systemctl enable --now agent-department-web.service
python3 - <<'PY'
from pathlib import Path
import datetime, shutil, subprocess
config = Path('/opt/ai-mortgage-v0.1.6/docker/nginx/nginx.conf')
text = config.read_text()
if 'location ^~ /agent-department/' not in text:
    marker = '    # 内部端（桌面优先）'
    if text.count(marker) != 1:
        raise SystemExit('Edge config changed: inspect before adding route')
    backup = config.with_name('nginx.conf.before-agent-' + datetime.datetime.now().strftime('%Y%m%d%H%M%S'))
    shutil.copy2(config, backup)
    # Preserve inode: the running edge container bind-mounts this file.
    config.write_text(text.replace(marker, Path('/opt/agent-department/edge-location.conf').read_text() + '\n' + marker))
    try:
        subprocess.run(['podman', 'exec', 'docker_nginx_1', 'nginx', '-t'], check=True)
        subprocess.run(['podman', 'exec', 'docker_nginx_1', 'nginx', '-s', 'reload'], check=True)
    except Exception:
        config.write_text(text)
        subprocess.run(['podman', 'exec', 'docker_nginx_1', 'nginx', '-s', 'reload'])
        raise
    print('Edge backup:', backup)
else:
    print('已保留为伍现有边缘代理路由')
PY
podman ps --filter name=agent-department-web --format '{{.Names}} {{.Status}}'
'''
subprocess.run(ssh + ['sh -s'], input=remote, text=True, check=True)

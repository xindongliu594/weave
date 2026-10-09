#!/usr/bin/env python3
"""JJ metadata-only OpenRig 0.6.6 foreground launcher; no inherited model keys."""
from pathlib import Path
import hashlib
import json
import os
import re

ROOT = Path('/home/jj/.local/share/weiwu')
BASE = ROOT / 'data/pilot/openrig'
PACKAGE = ROOT / 'runtime/openrig-v0.6.6/node_modules/@openrig/cli'
NODE = ROOT / 'runtime/node-v24.19.0-linux-x64/bin/node'
PORT = 57415
URL = 'http://127.0.0.1:' + str(PORT)
PINNED = {
    'daemon/dist/index.js': '492e61f92b45b5166532cd82351d1bab6cab8663836c2b4b463cb63bc9cc55b9',
    'daemon/dist/startup.js': '657a0667e91caeac5adcf40eeae61a1c4d4476cb8343db9dc52ecc752fb6c154',
    'daemon/dist/domain/kernel-boot.js': 'c27d50f1a9f61cdc358fc759d4b136ed69b7f46f016496744785a5247018cc92',
    'daemon/dist/daemon-shutdown.js': 'f561becb841c389a24e69992f21186d63f2db1a05b60ebab929617bf25cf146d',
    'dist/bin-wrapper.js': 'dd76e3f0cc2776c2dc10791cbbb95de7978b4963c995fe321d8bcf454df6b2f3',
    'dist/client.js': '4933440a259e311f3a044f0bd8326fb5938ae5335b14dd9ccad945e7ddc0f51e',
    'dist/commands/import.js': '72179d64dc9d0b444897e373dce3bd1ac9de75e9a1d7dd3cd357ec089ee35ca9',
    'daemon/dist/domain/rigspec-instantiator.js': '84cf240cb4e5e65de248bda60b7605c5c7128f462499706f21ae4077f719ac11',
    'daemon/dist/domain/queue-repository.js': 'e3b7f51059001f51ed7f904ead0235f0637cc3bfd74fe19e3d1cd286846d8e00',
}

def checked_path(value, exists=True):
    value = Path(value)
    if not value.is_absolute() or value.resolve() != value:
        raise RuntimeError('Noncanonical path or symbolic link refused')
    for item in [value, *value.parents]:
        if item.is_symlink():
            raise RuntimeError('Linked path refused')
    if exists and not value.exists():
        raise RuntimeError('Required path missing')
    if value.exists() and value.is_file() and value.stat().st_nlink != 1:
        raise RuntimeError('Hard-linked file refused')
    return value

def runtime_check():
    checked_path(PACKAGE)
    checked_path(NODE)
    if json.loads((PACKAGE / 'package.json').read_text())['version'] != '0.6.6':
        raise RuntimeError('OpenRig version changed')
    for relative, digest in PINNED.items():
        if hashlib.sha256(checked_path(PACKAGE / relative).read_bytes()).hexdigest() != digest:
            raise RuntimeError('Pinned OpenRig source changed: ' + relative)

def clean_environment():
    checked_path(BASE)
    token_file = checked_path(BASE / 'terminal-token')
    if token_file.stat().st_uid != os.getuid() or token_file.stat().st_mode & 0o077:
        raise RuntimeError('Terminal token must be private to the service user')
    token = token_file.read_text().strip()
    if not re.fullmatch(r'[A-Za-z0-9_-]{40,100}', token):
        raise RuntimeError('Invalid terminal token')
    # Construct from scratch. HOME also isolates default CLI auth/config lookup.
    # No API_KEY, ACCESS_TOKEN, proxy, provider, SSH, or inherited OpenRig options.
    return {
        'HOME': str(BASE / 'home'), 'USER': 'jj', 'LOGNAME': 'jj', 'LANG': 'C.UTF-8',
        'PATH': str(NODE.parent) + ':/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        'TMPDIR': str(BASE / 'tmp'), 'XDG_CONFIG_HOME': str(BASE / 'home/.config'),
        'XDG_CACHE_HOME': str(BASE / 'home/.cache'), 'OPENRIG_HOME': str(BASE / 'state'),
        'OPENRIG_DB': str(BASE / 'state/openrig.sqlite'), 'OPENRIG_PORT': str(PORT),
        'OPENRIG_BIND_HOST': '127.0.0.1', 'OPENRIG_HOST': '127.0.0.1',
        'OPENRIG_URL': URL, 'OPENRIG_NO_KERNEL': '1', 'OPENRIG_TRANSCRIPTS_ENABLED': 'false',
        'OPENRIG_TERMINAL_BEARER_TOKEN': token,
    }

def main():
    runtime_check()
    environment = clean_environment()
    for name in ['home', 'state', 'tmp', 'workspace']:
        checked_path(BASE / name)
    os.umask(0o077)
    os.chdir(BASE)
    # Official entry calls startServer() when executed directly, stays foreground,
    # and owns SIGTERM draining + daemon-shutdown.json. systemd owns this PID.
    os.execve(NODE, [str(NODE), str(PACKAGE / 'daemon/dist/index.js')], environment)

if __name__ == '__main__':
    main()

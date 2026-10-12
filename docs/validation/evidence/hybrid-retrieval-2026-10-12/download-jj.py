"""Download into the owned JJ experiment directory, verifying the existing lock."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time

root = Path('/home/jj/.local/share/weiwu/validation/hybrid-retrieval-20261012')
assert root.is_absolute() and not root.is_symlink()
root.mkdir(parents=True, exist_ok=True, mode=0o700)
os.chmod(root, 0o700)
lock = json.loads((root / 'model-lock.json').read_text())
records = []
for name, expected in lock['files'].items():
    target = root / 'models' / lock['repository'] / name
    assert target.resolve().is_relative_to(root.resolve())
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists() and hashlib.file_digest(target.open('rb'), 'sha256').hexdigest() == expected:
        records.append({'file': name, 'sha256': expected, 'bytes': target.stat().st_size, 'cached': True})
        continue
    partial = target.with_name(target.name + '.partial')
    url = 'https://hf-mirror.com/' + lock['repository'] + '/resolve/' + lock['revision'] + '/' + name
    start = time.monotonic()
    result = subprocess.run(['curl', '-4', '--fail', '--silent', '--show-error', '--location',
                             '--connect-timeout', '15', '--max-time', '240', '--output', str(partial), url],
                            capture_output=True)
    if result.returncode:
        print(json.dumps({'file': name, 'passed': False, 'curlCode': result.returncode,
                          'downloadedBytes': partial.stat().st_size if partial.exists() else 0}), flush=True)
        raise SystemExit(result.returncode)
    with partial.open('rb') as stream:
        actual = hashlib.file_digest(stream, 'sha256').hexdigest()
    assert actual == expected, 'Pinned model SHA256 mismatch: ' + name
    partial.replace(target)
    record = {'file': name, 'sha256': actual, 'bytes': target.stat().st_size,
              'seconds': time.monotonic() - start, 'cached': False}
    records.append(record)
    print(json.dumps(record), flush=True)
report = {'repository': lock['repository'], 'revision': lock['revision'], 'downloadHost': 'hf-mirror.com',
          'verification': 'Every file matches the repository model-lock.json SHA256', 'files': records}
(root / 'model-download.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'passed': True, 'files': len(records)}), flush=True)

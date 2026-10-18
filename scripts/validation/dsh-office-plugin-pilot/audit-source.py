"""Compare installed plugin bytes with the original tarball, without extracting it."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import tarfile

root = Path(__file__).resolve().parents[3]
pilot = root / '.data/plugin-pilot-20261018'
installed = pilot / 'node_modules/@huiliyi37/dsh-office'
files = []
with tarfile.open(pilot / 'huiliyi37-dsh-office-0.2.4.tgz', 'r:gz') as archive:
    for entry in archive:
        if not entry.isfile():
            continue
        relative = PurePosixPath(entry.name)
        assert relative.parts[0] == 'package' and '..' not in relative.parts
        target = installed.joinpath(*relative.parts[1:])
        original = archive.extractfile(entry).read()
        assert target.read_bytes() == original, entry.name
        files.append({'path': str(relative), 'sha256': hashlib.sha256(original).hexdigest()})
assert len(files) == 46
result = {'package': '@huiliyi37/dsh-office', 'version': '0.2.4', 'matchedFiles': len(files), 'allBytesEqual': True, 'files': files}
(pilot / 'source-audit.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
print(json.dumps({key: value for key, value in result.items() if key != 'files'}))

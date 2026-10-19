"""Read only public application APIs; never read process credentials or mutate DB."""
import json
import pathlib
import urllib.request
from decimal import Decimal

ROOT = pathlib.Path('/home/jj/.local/share/weiwu/validation/task-driven-organization-20261018/real-20261019')
def get(path):
    with urllib.request.urlopen('http://127.0.0.1:4310/api/' + path, timeout=30) as r:
        return json.load(r)

if __name__ == '__main__':
    ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    data = {name: get(name) for name in ['health', 'usage', 'costs', 'departments', 'projects', 'runs', 'models']}
    data['oldRun'] = get('runs/c6516254-6ab0-44c3-88f8-f9e86ac81592?limit=1')
    with (ROOT / 'preflight.json').open('x', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    dept = next(d for d in data['departments'] if d['id'] == '830c5454-a0d8-477c-912c-2273dfd2b7de')
    project = next(p for p in data['projects'] if p['id'] == '5b0f9606-859f-4c63-96b3-4e7e0d7412ec')
    model = next(m for m in data['models'] if m['id'] == 'c8a4e6ad-1aaf-43a4-8ba1-d0a6cce59051')
    print(json.dumps({'health': data['health'], 'usageCount': len(data['usage']), 'spent': str(sum(Decimal(str(u['cost'])) for u in data['usage'])),
      'calls': data['costs'].get('calls'), 'active': [r for r in data['runs'] if r['status'] in ['running', 'queued']],
      'department': dept, 'oldPolicy': project['policy'], 'oldTasks': project['plan']['tasks'], 'model': model}, ensure_ascii=False))

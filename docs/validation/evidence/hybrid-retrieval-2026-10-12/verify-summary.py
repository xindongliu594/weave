"""Recompute public aggregates and validate recorded execution/check/cleanup evidence."""
import hashlib
import json
from pathlib import Path
from statistics import median

root = Path(__file__).parent
result = json.loads((root / 'public-summary.json').read_text(encoding='utf-8'))
assert result['completed'] and result['helperStopped']
assert result['evaluatorSha256'] == hashlib.sha256((root / 'evaluation-source.ts').read_bytes()).hexdigest()
assert len(result['guards']) == 30 and all(g['passed'] for g in result['guards'])
assert sum(len(c['cases']) for c in result['corpora']) == 19
preservation = result['productionPreservation']
assert preservation['unchanged'] and preservation['paidModelCallsAdded'] == 0
assert preservation['before'] == preservation['after']
wire = (root / 'public-summary.json').read_text(encoding='utf-8')
for forbidden in ['"content":', '"query":', '"documentId":', '"documents":', '"_vectors":', '"credential":', '"apiKey":']:
    assert forbidden not in wire
for path, expected in result['sourceHashes'].items():
    assert hashlib.sha256(Path(path).read_bytes()).hexdigest() == expected

conventional_medians = {}
for corpus in result['corpora']:
    conventional_medians[corpus['label']] = {}
    for name, summary in corpus['engines'].items():
        positives = [q['engines'][name] for q in corpus['cases'] if q['expectedCount']]
        negatives = [q['engines'][name] for q in corpus['cases'] if not q['expectedCount']]
        assert summary['positiveQueries'] == len(positives)
        assert summary['top1Hits'] == sum(p['top1Correct'] for p in positives)
        assert summary['mrr'] == sum(p['reciprocalRank'] for p in positives) / len(positives)
        assert summary['returned'] == sum(p['returned'] for p in positives)
        assert summary['relevant'] == sum(p['relevant'] for p in positives)
        assert summary['positiveQueryRecall'] == sum(p['relevant'] > 0 for p in positives) / len(positives)
        assert summary['noAnswerQueries'] == len(negatives)
        assert summary['noAnswerFalseHits'] == sum(p['falseHits'] for p in negatives)
        assert summary['noAnswerFalseQueries'] == sum(p['falseHits'] > 0 for p in negatives)
        times = []
        for case in corpus['cases']:
            timing = case['engines'][name]['timing']
            assert timing['samples'] == 5 and timing['p95Ms'] == timing['maxMs']
            assert timing['maxMs'] >= timing['medianMs'] >= 0
            times.append(timing['medianMs'])
        assert sorted(times)[len(times) // 2] == summary['medianOfQueryMediansMs']
        conventional_medians[corpus['label']][name] = median(times)

checks = json.loads((root / 'checks.json').read_text(encoding='utf-8'))
for name in ['integration', 'chunks', 'typecheck', 'build']:
    assert checks[name]['exit_code' if name != 'typecheck' else 'exitCode'] == 0
for name in ['integration', 'chunks']:
    assert 'fail 0' in checks[name]['output']
assert 'built in' in checks['build']['output']
jj = json.loads((root / 'jj-cleanup.json').read_text(encoding='utf-8'))
windows = json.loads((root / 'windows-cleanup.json').read_text(encoding='utf-8-sig'))
assert not jj['helperRunning'] and not jj['productionFilesRemoved']
assert jj['rootPermissions'] == '0o700'
assert not windows['scratchExists'] and not windows['historicalRunsRemoved'] and not windows['productionDataRemoved']
assert not Path('.data/hybrid-retrieval-20261012').exists()
print(json.dumps({'passed': True, 'queries': 19, 'guardGroups': 30,
                  'checksPassed': 4, 'conventionalMediansMs': conventional_medians}, indent=2))

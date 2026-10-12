"""Verify archived real-model observations; never starts a model or sends API calls."""
from pathlib import Path
import hashlib
import json

root = Path(__file__).parent
summary = json.loads((root / 'public-summary.json').read_text())
cal, test = summary['calibration'], summary['test']
for phase in [cal, test]:
    assert phase['completed'] and phase['helpersStopped']
    assert all(g['passed'] for g in phase['guards'])
    for name, expected in phase['sourceHashes'].items():
        assert hashlib.sha256((root / name).read_bytes()).hexdigest() == expected
    assert hashlib.sha256((root / 'cases.json').read_bytes()).hexdigest() == phase['casesHash']
assert cal['sourceHashes'] == test['sourceHashes'] and cal['thresholds'] == test['thresholds']
assert len(cal['calibrationQueries']) == 14 and len(test['queries']) == 41
assert summary['productionPreservation']['unchanged']
assert summary['productionPreservation']['before'] == summary['productionPreservation']['after']
excluded = set(summary['paraphraseRecheckIntents'])
assert excluded == {'inventory-holdout', 'deploy-holdout'}
cases = [q for q in test['queries'] if not q['regression'] and q['intent'] not in excluded]
positive = [q for q in cases if q['expectedCount']]
negative = [q for q in cases if not q['expectedCount']]
assert len(cases) == 20 and len(positive) == len(negative) == 10
metrics = {}
for name in cases[0]['engines']:
    metrics[name] = {'top1Hits': sum(q['engines'][name]['top1Correct'] for q in positive),
                     'noAnswerFalseQueries': sum(q['engines'][name]['noAnswerFalse'] for q in negative)}
    for q in test['queries']:
        scores = q['engines'][name]
        assert len(scores['timesMs']) == (1 if q['regression'] else 5)
        assert all(t >= 0 for t in scores['timesMs'])
        assert 0 <= scores['relevant'] <= scores['returned']
expected = {'original': (10, 8), 'localRrf': (10, 10), 'e5Gate': (6, 1), 'meiliRaw': (10, 10),
            'meiliGate': (6, 1), 'flashRaw': (6, 10), 'flashGate': (3, 2)}
assert {k: (v['top1Hits'], v['noAnswerFalseQueries']) for k, v in metrics.items()} == expected
new = json.loads((root / 'new-trial-cleanup.json').read_text())
old = json.loads((root / 'earlier-cache-cleanup.json').read_text())
assert new['localTrialStopped'] and not new['productionFilesRemoved'] and not new['historicalRunsRemoved']
assert not old['productionFilesRemoved'] and old['privateKnowledgeAndOriginalEvidenceRetained']
removed = sum(x['logicalBytes'] for x in new['heavyTrialArtifactsRemoved']) + sum(x['logicalBytes'] for x in old['removedTrialCaches'])
assert removed == 956294791
mutation = json.loads((root / 'mutation-check.json').read_text())
assert mutation['exitCode'] != 0 and mutation['caughtByAssertions']
for forbidden in ['"query":', '"content":', '"documentId":', '"_vectors":', '"credential":', '"apiKey":']:
    assert forbidden not in (root / 'public-summary.json').read_text()
print(json.dumps({'passed': True, 'independentCases': 20, 'paraphraseRechecks': 2, 'regressionCases': 19,
                  'metrics': metrics, 'heavyArtifactsRemovedBytes': removed}, indent=2))

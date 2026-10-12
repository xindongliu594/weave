"""Offline, bounded CPU adapter; tokenization/scoring is unchanged FlashRank code."""
import hashlib
import json
import logging
from pathlib import Path
import resource
import socket
import sys
import time

root = Path('/home/jj/.local/share/weiwu/validation/rag-relevance-20261012')
report = json.loads((root / 'model-download.json').read_text())
for name, metadata in report['files'].items():
    with (root / 'models' / name).open('rb') as stream:
        assert hashlib.file_digest(stream, 'sha256').hexdigest() == metadata['sha256']

import onnxruntime as ort
from flashrank import Ranker, RerankRequest
from tokenizers import Tokenizer

class OfflineRanker(Ranker):
    # The upstream constructor has no thread options and can download missing models.
    def __init__(self):
        self.logger = logging.getLogger('offline-reranker')
        self.model_dir = root / 'models/ms-marco-MultiBERT-L-12'
        self.llm_model = None
        options = ort.SessionOptions()
        options.intra_op_num_threads = 2
        options.inter_op_num_threads = 1
        self.session = ort.InferenceSession(str(self.model_dir / 'flashrank-MultiBERT-L12_Q.onnx'),
                                            sess_options=options, providers=['CPUExecutionProvider'])
        self.tokenizer = self._get_tokenizer(512)

def deny_network(*args, **kwargs):
    raise RuntimeError('Network is disabled in the local rerank worker')

socket.socket = deny_network
started = time.perf_counter()
ranker = OfflineRanker()
raw_tokenizer = Tokenizer.from_file(str(ranker.model_dir / 'tokenizer.json'))
raw_tokenizer.no_truncation()
print(json.dumps({'ready': True, 'startupMs': (time.perf_counter() - started) * 1000,
                  'threads': 2, 'maxTokens': 512, 'peakRssKiB': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss}), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    started = time.perf_counter()
    passages = request['passages']
    assert isinstance(request['query'], str) and len(request['query']) <= 300
    assert len(passages) <= 20 and all(len(p['text']) <= 10000 for p in passages)
    counts = {p['id']: len(raw_tokenizer.encode(request['query'], p['text']).ids) for p in passages}
    rows = ranker.rerank(RerankRequest(query=request['query'], passages=passages)) if passages else []
    print(json.dumps({'id': request['id'], 'rows': [{'id': p['id'], 'score': float(p['score']),
                       'pairTokens': counts[p['id']], 'truncated': counts[p['id']] > 512} for p in rows],
                       'elapsedMs': (time.perf_counter() - started) * 1000,
                       'peakRssKiB': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss}), flush=True)

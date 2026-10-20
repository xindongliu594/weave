import { fixtureFile, readJson, readBounded, hash } from './files.mjs';

export function loadDataset() {
  const dataset = readJson(fixtureFile('synthetic-v1.json'));
  if (dataset.id !== 'weiwu-engineering-synthetic' || dataset.version !== '1' || dataset.executionKind !== 'fixture' || !Array.isArray(dataset.cases) || dataset.cases.length !== 5 || new Set(dataset.cases.map(c => c.id)).size !== 5) throw new Error('invalid-dataset');
  return dataset;
}

export class WeiwuProvider {
  constructor(options = {}) { this.config = options.config ?? {}; }
  id() { return 'weiwu:replay:synthetic-v1'; }
  async callApi(prompt, context = {}) {
    if (this.config.mode === 'execute') throw new Error('LIVE_AUTHORIZATION_REQUIRED');
    if (this.config.mode && this.config.mode !== 'replay') throw new Error('unsupported-mode');
    if (this.config.fixturePath) throw new Error('fixture-path-is-dataset-controlled');
    const dataset = loadDataset();
    const caseId = context.vars?.caseId ?? prompt;
    if (context.vars?.datasetVersion !== dataset.version) throw new Error('dataset-version-mismatch');
    const item = dataset.cases.find(c => c.id === caseId);
    if (!item) throw new Error('unknown-case');
    const bytes = readBounded(fixtureFile(item.fixture), 64 * 1024);
    if (hash(bytes) !== item.digest) throw new Error('fixture-digest-mismatch');
    const evidence = JSON.parse(bytes.toString('utf8'));
    if (evidence.caseId !== item.id || evidence.datasetVersion !== dataset.version || evidence.executionKind !== 'fixture' || evidence.modelExecuted !== false || evidence.fresh !== false) throw new Error('fixture-provenance-mismatch');
    return { output: JSON.stringify(evidence), tokenUsage: { total: 0, prompt: 0, completion: 0 }, cost: 0 };
  }
}
export default WeiwuProvider;

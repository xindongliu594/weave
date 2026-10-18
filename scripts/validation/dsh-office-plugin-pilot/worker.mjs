import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { installApprovedSkills } from '../../../services/agent-runtime/approved-skills.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const runtimeRequire = createRequire(join(repo, 'services/agent-runtime/package.json'));
const baseRequire = createRequire(runtimeRequire.resolve('@deepseek-ai/dsh-base/package.json'));
const pilot = join(repo, '.data/plugin-pilot-20261018');
const pkg = join(pilot, 'node_modules/@huiliyi37/dsh-office');
const out = resolve(process.argv[2]);
assert.ok(out.startsWith(join(pilot, 'runs') + (process.platform === 'win32' ? '\\' : '/')));
assert.ok(process.permission, 'The worker requires Node permission mode');
const { LlmAdapter } = await import(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/dsh-llm')).href);
const { Context } = await import(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/cordis')).href);
const office = await import(pathToFileURL(join(pkg, 'lib/index.js')).href);
const AdmZip = runtimeRequire('../../node_modules/adm-zip');
const sha = text => createHash('sha256').update(text).digest('hex');
const content = '巡检汇报规则：记录原始次数及失败次数，计算失败比例，报告中注明来源；不得编造监控结果。';
const document = { documentId: 'pilot-company-method', title: '公司巡检汇报方法', version: 3, sha256: sha(content), source: { skillName: 'incident-report' } };
const manifest = { format: 'document-versions-v2', documents: [document], agentDocuments: { reader: [document.documentId], other: [] } };
const report = { kind: 'component-integration-not-model-acceptance', modelCalls: 0, checks: [], calls: [], artifacts: [], unmetRequirements: [], productionReady: false };
const check = (name, detail) => report.checks.push({ name, passed: true, detail });
const fibers = [], agents = [];
// Node 24 permission mode rejects fsync. Keep durable production Hosts unchanged;
// this probe uses DSH's native in-memory composition and the real company loader.
// This proves component interoperability, not EmployeeHostFactory rollout/recovery.
const compose = async id => {
  const ctx = new Context();
  const mount = async (name, config) => {
    const mod = await import(pathToFileURL(baseRequire.resolve(name)).href);
    const fiber = ctx.plugin(mod.default ?? mod, config); fibers.push(fiber); await fiber.await();
  };
  await mount('@deepseek-ai/dsh-llm');
  ctx.llm.registerAdapter(['local-pilot'], new class extends LlmAdapter {
    async *stream() { report.modelCalls++; throw Error('MODEL_CALL_FORBIDDEN_IN_PLUGIN_PILOT'); }
  }());
  for (const name of ['session', 'session-projection', 'system-prompt', 'tools', 'agent']) await mount('@deepseek-ai/dsh-' + name, name === 'tools' ? { mode: 'native' } : undefined);
  await mount('@deepseek-ai/dsh-agent-loop', { agents: [] });
  const officeFiber = ctx.plugin(office, { enable: { pdf: false } }); fibers.push(officeFiber); await officeFiber.await();
  const names = ctx.tools.schemas().map(t => t.name).sort();
  const handle = await ctx.agents.create({ sessionId: randomUUID(), meta: { cwd: out }, agentOptions: { provider: 'local-pilot', model: id },
    setup: scoped => { if (id === 'other') scoped.tools.restrict({ deny: names }); },
  });
  agents.push(handle);
  await installApprovedSkills(ctx, mount, { manifest, employee: { id, tools: id === 'reader' ? ['knowledge_search', 'knowledge_read'] : [] }, agent: handle.agent,
    queryKnowledge: async (_manifest, employeeId, operation, documentId) => {
      assert.equal(employeeId, 'reader'); assert.equal(operation, 'skill'); assert.equal(documentId, document.documentId);
      return { ...document, content };
    },
  });
  return { ctx, handle, names };
};
try {
  assert.throws(() => readFileSync(process.argv[3]), { code: 'ERR_ACCESS_DENIED' });
  check('filesystem-permission-blocks-ungranted-read', { fixture: 'public sibling fixture', expectedCode: 'ERR_ACCESS_DENIED' });
  const { ctx: readerCtx, handle: reader, names: officeNames } = await compose('reader');
  assert.deepEqual(officeNames, ['docx_create', 'docx_read', 'pptx_create', 'pptx_edit', 'pptx_read', 'xlsx_audit', 'xlsx_edit', 'xlsx_read', 'xlsx_recalc', 'xlsx_write']);
  check('original-plugin-registers-on-pinned-dsh', officeNames);
  const { ctx: otherCtx, handle: other } = await compose('other');
  const filesystemSkill = await import(pathToFileURL(baseRequire.resolve('@deepseek-ai/dsh-skill-filesystem')).href);
  const skillFiber = readerCtx.plugin(filesystemSkill.default ?? filesystemSkill, { includeDefaultRoots: false, customSkillDirs: [join(pkg, 'skills')] });
  fibers.push(skillFiber);
  await skillFiber.await();
  const catalog = await readerCtx.skills.list({ cwd: out, scope: reader.agent });
  assert.ok(catalog.some(s => s.name === 'dsh-office'));
  const company = catalog.find(s => s.name.includes('incident-report'));
  assert.ok(company);
  check('company-and-upstream-skills-share-native-catalog', catalog.map(s => ({ name: s.name, source: s.source, provider: s.provider })));
  const call = async (name, args, actor = reader, ctx = readerCtx, expectError = false) => {
    const started = Date.now();
    const result = await ctx.tools.execute({ name, arguments: args, agent: actor.agent, callId: randomUUID(), signal: AbortSignal.timeout(15000) });
    report.calls.push({ name, actor: actor.agent.options.model, elapsedMs: Date.now() - started, isError: result.isError, value: result.value, error: result.error });
    assert.equal(result.isError, expectError, `${name}: ${JSON.stringify(result)}`);
    return result;
  };
  assert.equal((await call('skill', { name: company.name })).value.content, content);
  const stockSkill = await call('skill', { name: 'dsh-office' });
  assert.ok(JSON.stringify(stockSkill.value).includes('xlsx_write'));
  check('both-skills-load-through-same-native-tool', { companyVersion: document.version, companySha256: document.sha256 });
  const forgedSkill = await call('skill', { name: company.name }, other, readerCtx, true);
  assert.match(forgedSkill.error?.message ?? '', /SKILL_PERMISSION_DENIED/);
  assert.equal(otherCtx.tools.get('skill'), undefined);
  check('company-skill-rejects-ungranted-employee', { guard: 'SKILL_PERMISSION_DENIED' });
  const docx = join(out, 'report.docx'), xlsx = join(out, 'metrics.xlsx'), pptx = join(out, 'brief.pptx');
  await call('docx_create', { destination_path: docx, title: '巡检报告', content: [
    { type: 'paragraph', text: '兼容性测试样例：10 次检查，2 次失败。' },
    { type: 'table', headers: ['指标', '数值'], rows: [['检查', '10'], ['失败', '2']] },
  ] });
  assert.ok((await call('docx_read', { file_path: docx })).value.content.includes('10 次检查'));
  await call('xlsx_write', { file_path: xlsx, sheet_name: '巡检', data: [['检查', '失败', '失败比例'], [10, 2, { formula: 'B2/A2' }]], header_bold: true });
  const recalc = await call('xlsx_recalc', { file_path: xlsx });
  assert.match(recalc.value.content, /status:\s*success/);
  const table = await call('xlsx_read', { file_path: xlsx, sheet: '巡检' });
  assert.match(table.value.content, /10/);
  assert.match(table.value.content, /2/);
  assert.match(table.value.content, /B2\/A2/);
  await call('pptx_create', { destination_path: pptx, slides: [
    { type: 'title', title: '巡检汇报', body: '组件兼容性样例' },
    { type: 'content', title: '统计', items: ['检查 10 次', '失败 2 次', '失败比例 20%'] },
  ] });
  assert.ok((await call('pptx_read', { file_path: pptx })).value.content.includes('失败比例 20%'));
  for (const [path, requiredPart, expected] of [[docx, 'word/document.xml', '巡检报告'], [xlsx, 'xl/worksheets/sheet1.xml', 'B2/A2'], [pptx, 'ppt/slides/slide2.xml', '失败比例 20%']]) {
    const bytes = readFileSync(path), zip = new AdmZip(bytes);
    assert.ok(zip.getEntry('[Content_Types].xml'));
    assert.ok(zip.readAsText(requiredPart).includes(expected));
    report.artifacts.push({ name: path.split(/[\\/]/).at(-1), bytes: bytes.length, sha256: sha(bytes), requiredPart });
  }
  // An independent XML assertion checks a real cached formula result, not just a success string.
  const sheetXml = new AdmZip(readFileSync(xlsx)).readAsText('xl/worksheets/sheet1.xml');
  assert.match(sheetXml, /<c\b[^>]*r="A2"[^>]*>\s*<v>10<\/v>\s*<\/c>/);
  assert.match(sheetXml, /<c\b[^>]*r="B2"[^>]*>\s*<v>2<\/v>\s*<\/c>/);
  assert.match(sheetXml, /<c\b[^>]*r="C2"[^>]*>\s*<f>B2\/A2<\/f>/);
  const documentXml = new AdmZip(readFileSync(docx)).readAsText('word/document.xml');
  const tableXml = documentXml.match(/<w:tbl>.*?<\/w:tbl>/s)?.[0];
  assert.ok(tableXml, 'DOCX must contain a real table');
  for (const value of ['指标', '数值', '检查', '10', '失败', '2']) assert.ok(tableXml.includes(`>${value}</w:t>`));
  const slideCount = new AdmZip(readFileSync(pptx)).getEntries().filter(entry => /^ppt\/slides\/slide\d+\.xml$/.test(entry.entryName)).length;
  assert.equal(slideCount, 2);
  const cachedResultPersisted = /<c\b[^>]*r="C2"[^>]*>\s*<f>B2\/A2<\/f>\s*<v>0\.2<\/v>\s*<\/c>/.test(sheetXml);
  if (!cachedResultPersisted) report.unmetRequirements.push({ id: 'xlsx-recalc-persisted-value', expected: 0.2, actual: 'No cached value in saved C2', toolReported: recalc.value.content });
  check('office-roundtrip-and-independent-package-checks', { inputs: { A2: 10, B2: 2 }, formula: 'B2/A2', cachedResultPersisted, slides: slideCount });
  const deniedFile = join(out, 'denied.docx');
  const denied = await call('docx_create', { destination_path: deniedFile, content: [{ type: 'paragraph', text: 'must not write' }] }, other, otherCtx, true);
  assert.equal(denied.error?.info?.code, 'UNKNOWN_TOOL');
  assert.equal(existsSync(deniedFile), false);
  assert.equal(otherCtx.tools.schemas(other.agent).some(t => officeNames.includes(t.name)), false);
  check('native-tool-restriction-denies-ungranted-employee', { deniedTools: officeNames.length, note: 'Explicit pilot setup; product dynamic grants not implemented' });
  const outside = resolve(process.argv[4]);
  const escape = await call('docx_create', { destination_path: outside, content: [{ type: 'paragraph', text: 'must not write' }] }, reader, readerCtx, true);
  assert.match(JSON.stringify(escape.error), /ERR_ACCESS_DENIED|Access.*denied|permission/i);
  assert.equal(process.permission.has('fs.write', outside), false);
  check('filesystem-permission-blocks-outside-write', { boundary: 'Node permission mode, not plugin or OpenShell guarantee' });
  assert.equal(report.modelCalls, 0);
  check('no-model-calls', 0);
} catch (error) {
  report.failure = { message: error.message, stack: error.stack };
  process.exitCode = 1;
} finally {
  for (const item of [...agents.reverse(), ...fibers.reverse()]) {
    try { await item.dispose(); } catch (error) { report.teardownError = error.message; process.exitCode = 1; }
  }
  report.probeCompleted = !process.exitCode;
  report.acceptancePassed = !process.exitCode && report.unmetRequirements.length === 0;
  if (!process.exitCode && report.unmetRequirements.length) process.exitCode = 2;
  writeFileSync(join(out, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ probeCompleted: report.probeCompleted, acceptancePassed: report.acceptancePassed, checks: report.checks.length, unmetRequirements: report.unmetRequirements, modelCalls: report.modelCalls, ...(report.failure ? { failure: report.failure.message } : {}) }));
}

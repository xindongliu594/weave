import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic';
import ToolResultPruner from '@deepseek-ai/dsh-compaction-tool-result-pruner';
import { dirname } from 'node:path';
import { readRun } from './trace-store.mjs';

const TEXT_KEYS = new Set(['content', 'output', 'text', 'snippet']);
const OMITTED_TEXT = '\n[... text omitted; this text is incomplete; original retained in session evidence ...]\n';
const TRUNCATED_CHECKPOINT = 'summarization truncated at the token cap (incomplete checkpoint)';
const completeFileRead = value => value && typeof value === 'object' && !Array.isArray(value) &&
  typeof value.path === 'string' && /^[a-f0-9]{64}$/.test(value.sha256 ?? '') && typeof value.content === 'string';

/** Keep structured file hashes, paths, status and citations around large text. */
export class EvidencePruner extends ToolResultPruner {
  pruneContent(blocks) {
    if (this.measureContent(blocks) <= this.config.thresholdChars) return null;
    // Loaded approved instructions must remain complete. Trimming steps can
    // silently change the method; the existing request byte guard still applies.
    if (blocks.some(block => block.type === 'text' && /^\s*<skill_content\b/.test(block.text))) return null;
    const parsed = blocks.map(block => {
      if (block.type !== 'text') return { block };
      try { return { block, json: true, value: JSON.parse(block.text) }; }
      catch { return { block }; }
    });
    if (!parsed.some(item => item.json)) return super.pruneContent(blocks);
    const structured = parsed.map(({ block, json, value }) => {
      if (!json) return block.type === 'text' ? super.pruneContent([block])?.[0] ?? block : block;
      // filesystem has no offset/limit read contract. Repeated reads would be
      // clipped again, so retain complete file text rather than giving an editor
      // a fragment that cannot be recovered through the authorized tool. The
      // adapter still enforces the unchanged total UTF-8 context byte limit.
      if (completeFileRead(value)) return block;
      let head = this.config.headChars, tail = this.config.tailChars, candidate = block;
      while (true) {
        let changed = false;
        const shorten = (item, key) => {
          if (typeof item === 'string' && TEXT_KEYS.has(key) && !item.includes(OMITTED_TEXT)) {
            const points = Array.from(item);
            if (points.length > head + tail + Array.from(OMITTED_TEXT).length) {
              changed = true;
              return points.slice(0, head).join('') + OMITTED_TEXT + (tail ? points.slice(-tail).join('') : '');
            }
          }
          if (Array.isArray(item)) return item.map(entry => shorten(entry, key));
          if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([name, entry]) => [name, shorten(entry, name)]));
          return item;
        };
        const shortened = shorten(value, '');
        if (changed) candidate = { ...block, text: JSON.stringify(shortened) };
        // Escaped text and surrounding metadata count toward the serialized
        // budget even when an individual text value is below that threshold.
        if (this.measureContent([candidate]) <= this.config.thresholdChars || !head && !tail) break;
        head = Math.floor(head / 2); tail = Math.floor(tail / 2);
      }
      return candidate;
    });
    // Metadata may itself exceed the soft per-tool threshold. Retain its valid
    // structure and full hashes instead of cutting JSON syntax or identifiers.
    return this.measureContent(structured) < this.measureContent(blocks) ? structured : null;
  }
}

/** Token capacity is declared by configuration; the byte guard stays independent. */
export function employeeContextPolicy(policy, routes, provider) {
  const bytes = policy.contextBytes ?? 64000;
  const thresholdChars = Math.max(256, Math.min(6000, Math.floor(bytes / 4)));
  return { mode: policy.contextManagement ?? 'summary', summaryGrowthTokens: Math.max(1024, Math.floor(bytes * 0.15 / 4)), pruning: {
    thresholdChars, headChars: Math.floor(thresholdChars * 0.3), tailChars: Math.floor(thresholdChars * 0.1),
  }, compaction: { modelPolicies: routes.filter(route => route.contextWindowTokens).map(route => {
    // This is a soft trigger in the meter's four-characters-per-token units.
    // Dividing bytes by twelve made the threshold smaller than ordinary fixed
    // prompts and tool schemas, which no history summary can remove. The wire
    // adapter independently enforces the actual UTF-8 byte limit for all scripts.
    const budget = Math.min(route.contextWindowTokens, Math.floor(Math.min(bytes, route.contextBytes ?? bytes) * 0.7 / 4));
    return { provider, model: route.id, thresholdRatio: Math.min(0.7, budget / route.contextWindowTokens),
      retainTokens: Math.max(1, Math.floor(budget * 0.24)),
      // The structured checkpoint can exceed 1024 tokens even for a small
      // development task. Use its already approved route allowance; the shared
      // adapter still clamps this call to the attributed task's output cap and
      // reserves it against the same task/project budgets and call counters.
      maxTokens: Math.max(64, Math.min(route.maxOutputTokens, Math.floor(budget * 0.22))),
    };
  }) } };
}

/** Verify the pinned backend's durable summary/replacement/end adjacency.
 * A failed or partially committed transaction never authorizes continuation.
 * Reconstructing this from the Session also preserves the gate on cold resume.
 */
function completedCheckpoint(session) {
  const events = session.snapshotEvents();
  const end = events.findLast(event => event.type === 'compaction/end');
  if (!end || end.seq < 2 || Object.hasOwn(end.data, 'error')) return;
  const summary = session.eventAt(end.seq - 2), replacement = session.eventAt(end.seq - 1);
  if (summary?.type !== 'compaction/summary' || summary.data.compactionId !== end.data.compactionId ||
      replacement?.type !== 'user/message' || replacement.surfaceOp?.op !== 'replace' ||
      replacement.data.source?.kind !== 'plugin' || replacement.data.source.plugin !== 'compact' ||
      replacement.data.source.compactionId !== end.data.compactionId ||
      !replacement.sourceEventSeqs?.includes(summary.seq) || !session.surface.nodes.includes(replacement.seq)) return;
  const start = session.eventAt(replacement.sourceEventSeqs[0]);
  const sources = new Set(replacement.sourceEventSeqs);
  if (start?.type !== 'compaction/start' || start.data.compactionId !== end.data.compactionId ||
      start.data.turn !== end.data.turn || !summary.data.shadowedSeqs.every(seq => sources.has(seq))) return;
  return { ...summary.data, startSeq: start.seq, summarySeq: summary.seq, endSeq: end.seq };
}

function truncatedCheckpoint(session, minimumSeq = 0) {
  const events = session.snapshotEvents(), end = events.findLast(event => event.type === 'compaction/end');
  if (!end || end.data.error !== TRUNCATED_CHECKPOINT) return;
  const start = events.findLast(event => event.type === 'compaction/start' && event.data.compactionId === end.data.compactionId);
  if (!start || start.seq < minimumSeq || start.data.turn !== end.data.turn ||
      session.snapshotEvents(start.seq + 1, end.seq).some(event => event.type === 'compaction/summary' || event.surfaceOp?.op === 'replace')) return;
  return { compactionId: end.data.compactionId, startSeq: start.seq, endSeq: end.seq };
}

function knownUsage(usage) {
  return usage && Number.isSafeInteger(usage.inputTokens) && usage.inputTokens >= 0 &&
    Number.isSafeInteger(usage.outputTokens) && usage.outputTokens > 0 &&
    ['cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens'].every(key =>
      usage[key] === undefined || Number.isSafeInteger(usage[key]) && usage[key] >= 0);
}

function confirmedSummaryCalls(archive, sessionId, model) {
  if (!archive?.dir || !archive.id) return;
  const run = readRun(dirname(archive.dir), archive.id);
  if (run?.integrity !== 'ok') return;
  const request = run.events.findLast(event => event.type === 'model/request' && event.sessionId === sessionId &&
    event.data.purpose === 'compaction' && event.data.model === model);
  if (!request) return;
  const calls = run.events.filter(event => event.seq > request.seq && event.type === 'model/wire-request' && event.sessionId === sessionId);
  if (!calls.length) return;
  const ids = calls.map(event => event.data.usageId);
  if (ids.some(id => typeof id !== 'string' || !id) || run.events.some(event => event.seq > request.seq &&
      event.type === 'billing/unconfirmed' && ids.includes(event.data.id))) return;
  if (!calls.every(call => run.events.some(event => event.seq > call.seq && event.type === 'billing/usage' &&
      event.sessionId === sessionId && event.data.id === call.data.usageId && event.data.modelId === call.data.modelId &&
      event.data.requestPurpose === 'compaction' && knownUsage(event.data) && Number.isFinite(event.data.cost) && event.data.cost >= 0))) return;
  return ids;
}

function addedHistoryTokens(session, measurement, checkpoint) {
  return measurement.nodes.reduce((tokens, node) => {
    if (node.seq <= checkpoint.endSeq) return tokens;
    const event = session.eventAt(node.seq), source = event.data?.source;
    // Fixed scaffolding is refreshed at every admitted step. Its growth still
    // reaches the unchanged wire byte guard, but cannot justify paying again
    // to summarize the same source history after a successful checkpoint.
    if (event.type === 'system/message' || event.type === 'user/message' &&
        source?.kind === 'plugin' && source.plugin === '@deepseek-ai/dsh-system-prompt' && source.form === 'snapshot') return tokens;
    return tokens + node.tokens;
  }, 0);
}

/** Each employee owns its meter, durable surface replacements and cancellation. */
export async function installEmployeeContext(ctx, mount, { mode = 'summary', archive, compaction = {}, pruning = {}, summaryGrowthTokens = 2400,
  requestPreview, onRetainOriginal } = {}) {
  if (mode === 'off') return;
  await mount('@deepseek-ai/dsh-token-meter');
  await mount(EvidencePruner, { thresholdChars: 6000, headChars: 1800, tailChars: 600, ...pruning });
  if (mode === 'summary') await mount(BasicCompactionEngine, {
    auto: false, thresholdRatio: 0.7, retainRatio: 0.24,
    compactionRetries: 0, maxOverflowRetries: 0, ...compaction,
  });
  const unknown = new Set();
  const deferred = new WeakMap();
  const attempts = new Map(), truncatedProofs = new Map();
  let restoredProofs = false;
  if (mode === 'summary') ctx.on('llm/stream', async function* (options, next) {
    if (options.purpose !== 'compaction') {
      const session = ctx.get('sessions')?.get(options.sessionId);
      if (session && retainedTruncation(session)) {
        if (typeof requestPreview !== 'function') throw Error('CONTEXT_PREFLIGHT_UNAVAILABLE: 原始历史退化必须先核对完整请求，未派发模型');
        const prepared = requestPreview(options);
        if (!prepared?.fitted || prepared.fitted.removed) throw Error('CONTEXT_LIMIT: 原始完整历史不能在当前字节与预算上限内继续；没有派发模型');
      }
      yield* next(); return;
    }
    const outcome = { provider: options.provider, model: options.model, completed: false };
    attempts.set(options.sessionId, outcome);
    // Production emits usage only after the actual fee has been persisted.
    // A rejected, aborted or missing-usage stream cannot enable degradation.
    for await (const chunk of next()) {
      if (chunk.type === 'usage') outcome.usage = structuredClone(chunk.usage);
      if (chunk.type === 'finish') outcome.finish = chunk.reason.kind;
      yield chunk;
    }
    outcome.completed = true;
  });
  const retainedTruncation = session => {
    const failed = truncatedCheckpoint(session);
    if (!failed) return;
    if (!truncatedProofs.has(failed.compactionId) && !restoredProofs) {
      restoredProofs = true;
      if (archive?.dir && archive.id) {
        const run = readRun(dirname(archive.dir), archive.id);
        if (run?.integrity !== 'ok') throw Error('摘要退化证据不完整，停止恢复');
        for (const event of run.events) if (event.type === 'context/summary-truncated-retained' && event.sessionId === session.id &&
            event.data.version === 2 && Array.isArray(event.data.billingUsageIds) && event.data.billingUsageIds.length &&
            event.data.billingUsageIds.every(id => run.events.some(receipt => receipt.type === 'billing/usage' &&
              receipt.sessionId === session.id && receipt.data.id === id && knownUsage(receipt.data) &&
              Number.isFinite(receipt.data.cost) && receipt.data.cost >= 0) &&
              !run.events.some(receipt => receipt.type === 'billing/unconfirmed' && receipt.data.id === id)))
          truncatedProofs.set(event.data.compactionId, event.data);
      }
    }
    const proof = truncatedProofs.get(failed.compactionId);
    if (proof?.version === 2 && proof.startSeq === failed.startSeq && proof.endSeq === failed.endSeq && knownUsage(proof.usage)) {
      onRetainOriginal?.(session.id, true);
      return { ...failed, provider: proof.provider, model: proof.model, retained: 'original' };
    }
  };
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    signal.throwIfAborted();
    const result = ctx.toolResultPruner.pruneSession(agent.session);
    if (result.pruned.length) archive?.append('context/pruned', result, { sessionId: agent.id });
    if (mode === 'summary' && agent.session.requestHeader()) {
      const route = agent.session.requestHeader().config;
      const info = await ctx.llm.resolveModelInfo(route.provider, route.model, signal);
      if (info.context) {
        const previous = completedCheckpoint(agent.session) ?? retainedTruncation(agent.session), measurement = ctx.tokenMeter.measure(agent.session);
        const growth = previous ? addedHistoryTokens(agent.session, measurement, previous) : undefined;
        const minimumGrowthTokens = Math.max(64, Math.min(summaryGrowthTokens, Math.floor(info.context.contextWindow * 0.15)));
        const sameRoute = previous?.provider === route.provider && previous?.model === route.model;
        if (sameRoute && growth < minimumGrowthTokens) {
          if (deferred.get(agent.session) !== previous.compactionId) {
            archive?.append('context/summary-deferred', { compactionId: previous.compactionId,
              addedHistoryTokens: growth, minimumGrowthTokens,
              retained: previous.retained ?? 'checkpoint',
              reason: '上次摘要尝试后的新历史尚未达到再次摘要门槛；继续使用完整保留上下文及原请求限制。' }, { sessionId: agent.id });
            deferred.set(agent.session, previous.compactionId);
          }
          signal.throwIfAborted(); return next();
        }
        const beforeSeq = agent.session.seq, generation = agent.session.surface.replaceGeneration;
        const surfaceNodes = [...agent.session.surface.nodes];
        attempts.delete(agent.id);
        let compacted;
        try { compacted = await ctx.compaction.compactIfNeeded(agent, 'pressure', signal); }
        catch (error) {
          // The upstream automatic listener treats pressure as a soft warning.
          // Continue only its specific post-success convergence failure, after
          // proving a complete durable replacement. Other failures stay closed.
          const pressure = /^compaction still above threshold after \d+ compaction attempts \((\d+) estimated tokens >= threshold (\d+)\)$/.exec(error?.message ?? '');
          const completed = pressure ? completedCheckpoint(agent.session) : undefined;
          if (signal.aborted) throw error;
          if (completed && completed.summarySeq >= beforeSeq && agent.session.surface.replaceGeneration > generation) {
            compacted = completed;
            archive?.append('context/summary-pressure-retained', { compactionId: completed.compactionId,
              estimatedTokens: Number(pressure[1]), softThresholdTokens: Number(pressure[2]), minimumGrowthTokens,
              reason: '摘要已完整提交；固定提示与保留尾部仍超过软门槛，后续请求继续接受原字节、费用和调用上限检查。' }, { sessionId: agent.id });
          } else {
            const outcome = attempts.get(agent.id);
            const failed = error?.code === 'MAX_TOKENS' && error.message === TRUNCATED_CHECKPOINT ? truncatedCheckpoint(agent.session, beforeSeq) : undefined;
            if (!failed || !outcome?.completed || outcome.finish !== 'max-tokens' || !knownUsage(outcome.usage) ||
                agent.session.surface.replaceGeneration !== generation || surfaceNodes.length !== agent.session.surface.nodes.length ||
                !surfaceNodes.every((seq, index) => seq === agent.session.surface.nodes[index]) || !archive?.append ||
                typeof requestPreview !== 'function' || typeof onRetainOriginal !== 'function') throw error;
            const billingUsageIds = confirmedSummaryCalls(archive, agent.id, outcome.model);
            if (!billingUsageIds) throw error;
            const proof = { version: 2, ...failed, provider: outcome.provider, model: outcome.model, usage: outcome.usage, billingUsageIds,
              minimumGrowthTokens, reason: '残缺摘要未采用；本次费用已确认且原历史未变，后续原始请求仍须通过持久化与原请求限制。' };
            archive.append('context/summary-truncated-retained', proof, { sessionId: agent.id });
            truncatedProofs.set(failed.compactionId, proof);
            onRetainOriginal?.(agent.id, true);
          }
        }
        if (compacted) {
          onRetainOriginal?.(agent.id, false);
          archive?.append('context/summarized', { compactionId: compacted.compactionId, sourceSeqs: compacted.shadowedSeqs,
            shadowedTokenCount: compacted.shadowedTokenCount }, { sessionId: agent.id });
        }
      } else if (!unknown.has(route.model)) {
        unknown.add(route.model);
        archive?.append('context/capacity-unknown', { modelId: route.model, mode: 'prune', reason: '未配置模型上下文容量，保留工具缩减和字节上限保护。' }, { sessionId: agent.id });
      }
    }
    signal.throwIfAborted();
    return next();
  });
}

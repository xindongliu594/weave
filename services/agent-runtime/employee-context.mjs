import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic';
import ToolResultPruner from '@deepseek-ai/dsh-compaction-tool-result-pruner';

const TEXT_KEYS = new Set(['content', 'output', 'text', 'snippet']);
const OMITTED_TEXT = '\n[... text omitted; this text is incomplete; original retained in session evidence ...]\n';
const completeFileRead = value => value && typeof value === 'object' && !Array.isArray(value) &&
  typeof value.path === 'string' && /^[a-f0-9]{64}$/.test(value.sha256 ?? '') && typeof value.content === 'string';

/** Keep structured file hashes, paths, status and citations around large text. */
export class EvidencePruner extends ToolResultPruner {
  pruneContent(blocks) {
    if (this.measureContent(blocks) <= this.config.thresholdChars) return null;
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
  return { mode: policy.contextManagement ?? 'summary', pruning: {
    thresholdChars, headChars: Math.floor(thresholdChars * 0.3), tailChars: Math.floor(thresholdChars * 0.1),
  }, compaction: { modelPolicies: routes.filter(route => route.contextWindowTokens).map(route => {
    // This is a soft trigger in the meter's four-characters-per-token units.
    // Dividing bytes by twelve made the threshold smaller than ordinary fixed
    // prompts and tool schemas, which no history summary can remove. The wire
    // adapter independently enforces the actual UTF-8 byte limit for all scripts.
    const budget = Math.min(route.contextWindowTokens, Math.floor(Math.min(bytes, route.contextBytes ?? bytes) * 0.7 / 4));
    return { provider, model: route.id, thresholdRatio: Math.min(0.7, budget / route.contextWindowTokens),
      retainTokens: Math.max(1, Math.floor(budget * 0.24)),
      maxTokens: Math.max(64, Math.min(1024, route.maxOutputTokens, Math.floor(budget * 0.22))),
    };
  }) } };
}

/** Each employee owns its meter, durable surface replacements and cancellation. */
export async function installEmployeeContext(ctx, mount, { mode = 'summary', archive, compaction = {}, pruning = {} } = {}) {
  if (mode === 'off') return;
  await mount('@deepseek-ai/dsh-token-meter');
  await mount(EvidencePruner, { thresholdChars: 6000, headChars: 1800, tailChars: 600, ...pruning });
  if (mode === 'summary') await mount(BasicCompactionEngine, {
    auto: false, thresholdRatio: 0.7, retainRatio: 0.24, maxTokens: 1024,
    compactionRetries: 0, maxOverflowRetries: 0, ...compaction,
  });
  const unknown = new Set();
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    signal.throwIfAborted();
    const result = ctx.toolResultPruner.pruneSession(agent.session);
    if (result.pruned.length) archive?.append('context/pruned', result, { sessionId: agent.id });
    if (mode === 'summary' && agent.session.requestHeader()) {
      const route = agent.session.requestHeader().config;
      const info = await ctx.llm.resolveModelInfo(route.provider, route.model, signal);
      if (info.context) {
        const compacted = await ctx.compaction.compactIfNeeded(agent, 'pressure', signal);
        if (compacted) archive?.append('context/summarized', {
          compactionId: compacted.compactionId, sourceSeqs: compacted.shadowedSeqs,
          shadowedTokenCount: compacted.shadowedTokenCount,
        }, { sessionId: agent.id });
      } else if (!unknown.has(route.model)) {
        unknown.add(route.model);
        archive?.append('context/capacity-unknown', { modelId: route.model, mode: 'prune', reason: '未配置模型上下文容量，保留工具缩减和字节上限保护。' }, { sessionId: agent.id });
      }
    }
    signal.throwIfAborted();
    return next();
  });
}

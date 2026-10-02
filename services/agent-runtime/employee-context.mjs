import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic';
import ToolResultPruner from '@deepseek-ai/dsh-compaction-tool-result-pruner';

const TEXT_KEYS = new Set(['content', 'output', 'text', 'snippet']);

/** Keep structured file hashes, paths, status and citations around large text. */
export class EvidencePruner extends ToolResultPruner {
  pruneContent(blocks) {
    if (this.measureContent(blocks) <= this.config.thresholdChars) return null;
    let changed = false;
    const shorten = (value, key) => {
      const points = typeof value === 'string' ? Array.from(value) : undefined;
      if (points && TEXT_KEYS.has(key) && points.length > this.config.thresholdChars) {
        changed = true;
        return points.slice(0, this.config.headChars).join('') + '\n[... text omitted; original retained in session evidence ...]\n' + (this.config.tailChars ? points.slice(-this.config.tailChars).join('') : '');
      }
      if (Array.isArray(value)) return value.map(item => shorten(item, key));
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, shorten(item, name)]));
      return value;
    };
    const structured = blocks.map(block => {
      if (block.type !== 'text') return block;
      try { return { ...block, text: JSON.stringify(shorten(JSON.parse(block.text), '')) }; }
      catch { return block; }
    });
    if (changed && this.measureContent(structured) <= this.config.thresholdChars) return structured;
    return super.pruneContent(blocks);
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

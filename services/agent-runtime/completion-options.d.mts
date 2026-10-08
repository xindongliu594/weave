import type { CompletionProtocol } from './completion-protocol.mjs';
export function modelCompletionOptions(model: { protocol?: CompletionProtocol; thinkingMode?: 'disabled' }): { thinking?: { type: 'disabled' } };

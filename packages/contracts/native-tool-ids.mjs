export const BUILTIN_TOOL_NAMES = Object.freeze(['artifact_write', 'filesystem', 'terminal', 'terminal_test', 'knowledge_search', 'knowledge_read', 'browser_read', 'mcp_call_readonly']);
export function isNativeToolName(value) { return typeof value === 'string' && value.length <= 64 && /^plugin__[a-z][a-z0-9_]{0,19}__[a-z][a-z0-9_]{0,31}$/.test(value); }

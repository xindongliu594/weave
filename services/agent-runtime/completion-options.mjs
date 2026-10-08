/** Only explicit model configuration changes the provider's thinking default. */
export function modelCompletionOptions(model) {
  if (model.thinkingMode === undefined) return {};
  if (model.thinkingMode !== 'disabled') {
    const error = new Error('思考模式配置无效；仅支持显式关闭或沿用中转站默认');
    error.code = 'INVALID_THINKING_MODE'; throw error;
  }
  if (model.protocol === 'responses') {
    const error = new Error('关闭 thinking 仅适用于 Chat Completions，不能与 Responses 配置组合');
    error.code = 'THINKING_PROTOCOL_MISMATCH'; throw error;
  }
  return { thinking: { type: 'disabled' } };
}

const identityFields = ['name', 'agent', 'arguments', 'callId', 'token', 'rootCallId', 'parent', 'deferContext', 'concludeTurn'];
const denied = 'TASK_TOOL_DENIED: 工具未获当前运行授权';

function freezeJson(value) {
  const copy = structuredClone(value);
  const freeze = item => {
    if (item && typeof item === 'object' && !Object.isFrozen(item)) {
      for (const child of Object.values(item)) freeze(child);
      Object.freeze(item);
    }
    return item;
  };
  return freeze(copy);
}

/** Keep DSH registration/dispatch; every registered body rechecks the final guard admission. */
export function installTaskToolBoundary(ctx) {
  const tools = ctx.tools, originalDescriptor = Object.getOwnPropertyDescriptor(tools, 'register');
  const register = tools.register, admissions = new WeakMap(), definitions = new WeakSet();
  if (tools.schemas().length) throw Error('TASK_TOOL_BOUNDARY_ORDER: 必须在注册工具之前安装执行门禁');
  let policy = () => denied, disposed = false, closed = false;
  const check = (exec, definition) => {
    if (closed || disposed || !exec.agent || !definition || !definitions.has(definition)) return denied;
    const reason = policy(exec, definition);
    if (reason !== undefined && typeof reason !== 'string') return 'TASK_TOOL_POLICY_INVALID: 授权检查必须同步返回拒绝原因';
    return reason;
  };
  function registerWrapped(source) {
    const rawExecute = source.execute;
    if (typeof rawExecute !== 'function') throw TypeError('TASK_TOOL_DEFINITION_INVALID: 工具缺少执行函数');
    const captured = Object.freeze({ ...source, parameters: freezeJson(source.parameters),
      output: Object.freeze({ ...source.output, schema: freezeJson(source.output.schema) }), execute: rawExecute });
    const definition = Object.freeze({ ...captured, async execute(args, exec) {
      const admission = admissions.get(exec);
      if (!admission || args !== exec.arguments || admission.definition !== definition || admission.identity.some((value, index) => exec[identityFields[index]] !== value) ||
        ctx.tools.get(definition.name, exec.agent) !== definition) throw Error('TASK_TOOL_BINDING_CHANGED: 工具调用或实际注册定义已改变');
      const reason = check(exec, definition);
      if (reason !== undefined) throw Error(reason);
      return Reflect.apply(rawExecute, captured, [args, exec]);
    } });
    definitions.add(definition);
    // The native method needs its calling scope, including agent.ctx registrations.
    return Reflect.apply(register, this, [definition]);
  }
  // A stopped boundary must retain its guard beyond the cleanup effect's child disposals.
  const removeGuard = tools.guard(exec => {
    const definition = tools.get(exec.name, exec.agent), identity = identityFields.map(field => exec[field]);
    const reason = check(exec, definition);
    if (reason === undefined) admissions.set(exec, { definition, identity });
    return reason;
  });
  const dispose = ctx.effect(() => {
    // Cordis traces method reads; an accessor avoids fixed-data Proxy get invariants.
    Object.defineProperty(tools, 'register', { configurable: true, get: () => registerWrapped });
    return () => {
      disposed = true;
      if (closed) return;
      removeGuard();
      if (originalDescriptor) Object.defineProperty(tools, 'register', originalDescriptor);
      else delete tools.register;
    };
  }, 'task-tool-boundary');
  return { setPolicy(checkPolicy) {
    if (disposed || typeof checkPolicy !== 'function') throw Error('TASK_TOOL_POLICY_INVALID');
    policy = checkPolicy;
  }, stopAdmission() { closed = true; }, dispose };
}

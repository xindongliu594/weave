// Cordis 4.0.2 FiberState.UNLOADING is 5. Its public disposer awaits cleanup,
// but reports rejected cleanup through the structured logger instead of throwing.
const CORDIS_UNLOADING = 5; // @deepseek-ai/cordis/src/fiber.ts, pinned 4.0.2.
export function observeNativeTeardown(ctx) {
  let failed = false;
  const detach = ctx.logger.exporter({ levels: { default: 0 }, export(record) {
    if (record.type === 'error' && record.fiber?.deref()?.state === CORDIS_UNLOADING) failed = true;
  } });
  return {
    check() { if (failed) throw Object.assign(Error('RUNTIME_WRITER_DRAIN_FAILED'), { code: 'RUNTIME_WRITER_DRAIN_FAILED' }); },
    detach,
  };
}

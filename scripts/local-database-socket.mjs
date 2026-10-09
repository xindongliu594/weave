import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

/** Adapt the pinned 0.2.11 server's incomplete shutdown contract locally.
 * Its stop() does not await detach(), and handleClose removes a handler before
 * asynchronous transaction cleanup. Retain those handlers until cleanup ends.
 * No prototype or dependency files are changed. These ordinary JS members are
 * private in upstream TypeScript; fail closed if that integration shape changes.
 */
export function createLocalDatabaseSocket(options) {
  const socket = new PGLiteSocketServer(options);
  if (!(socket.handlers instanceof Set)) throw Error('Unsupported PGlite socket shutdown interface');
  const records = new Map(), tracked = new WeakSet(), failures = new Set();
  let stopped;
  const observe = promise => { promise.catch(error => { failures.add(error); }); return promise; };
  socket.addEventListener('connection', () => {
    for (const handler of socket.handlers) {
      if (tracked.has(handler)) continue;
      if (typeof handler.handleData !== 'function' || typeof handler.detach !== 'function' ||
          typeof handler.queryQueue?.clearQueueForHandler !== 'function') {
        throw Error('Unsupported PGlite handler shutdown interface');
      }
      const record = { reads: new Set(), detach: undefined };
      tracked.add(handler);
      records.set(handler, record);
      const handleData = handler.handleData.bind(handler), detach = handler.detach.bind(handler);
      handler.handleData = (...args) => {
        const work = handleData(...args);
        record.reads.add(work);
        // Upstream's data callback handles the query error. This tracks its
        // completion without introducing another unhandled rejection.
        work.then(() => record.reads.delete(work), () => record.reads.delete(work));
        return work;
      };
      handler.detach = close => {
        if (record.detach) return record.detach;
        handler.active = false;
        handler.queryQueue.clearQueueForHandler(handler.handlerId);
        record.detach = observe((async () => {
          // A currently executing query must finish before checking transaction
          // ownership. Queued work has been rejected above, so it cannot strand
          // this wait behind another client's transaction during shutdown.
          await Promise.allSettled([...record.reads]);
          return detach(close);
        })());
        record.detach.then(() => records.delete(handler), () => {});
        return record.detach;
      };
    }
  });
  const stop = socket.stop.bind(socket);
  socket.stop = () => stopped ??= (async () => {
    // Disable upstream connection admission before starting the drain. Every
    // subsequent close/error callback reuses its handler's same detach promise.
    const listenerStopped = stop();
    const drained = await Promise.allSettled([...records].map(([handler]) => handler.detach(true)));
    if (drained.some(result => result.status === 'rejected')) {
      // Release transport handles even when rollback fails. The database stays
      // open, and the failure is surfaced; there is no successful close claim.
      for (const handler of records.keys()) handler.socket?.destroy();
    }
    await listenerStopped;
    if (failures.size) throw new AggregateError([...failures], 'PGlite socket cleanup failed; database must remain open');
    records.clear();
  })();
  return socket;
}

import fs from 'node:fs';
import { createArchiveWriteFence } from '../archive-write-fence.mjs';
const args = JSON.parse(process.env.ARCHIVE_FENCE_TEST);
const fence = createArchiveWriteFence(args);
const guard = args.action === 'root' ? await fence.acquireRootExclusive() : ['source', 'timed-source'].includes(args.action) ? await fence.acquireSource(args.runId) : await fence.acquireWriter([args.runId]);
const sleeper = new Int32Array(new SharedArrayBuffer(4));
if (args.action === 'journal') {
  fence.withJournalAppendSync(guard, args.runId, () => {
    process.send({ ready: true }); Atomics.wait(sleeper, 0, 0, args.holdMs);
  });
  guard.release(); process.exit(0);
} else if (args.action === 'count') {
  process.send({ ready: true });
  process.once('message', () => {
    for (let i = 0; i < args.count; i++) fence.withJournalAppendSync(guard, args.runId, () => {
      const list = JSON.parse(fs.readFileSync(args.counter, 'utf8')); list.push(list.length + 1);
      Atomics.wait(sleeper, 0, 0, 2); fs.writeFileSync(args.counter, JSON.stringify(list));
    });
    guard.release(); process.exit(0);
  });
} else if (args.action === 'timed-source') {
  process.send({ ready: true });
  process.once('message', (ms) => setTimeout(() => { guard.release(); process.exit(0); }, ms));
} else {
  process.send({ ready: true }); setInterval(() => {}, 1000);
}

import { spawn } from 'node:child_process';
const children = [spawn(process.execPath, ['--import', 'tsx', 'apps/api/src/index.ts'], { stdio: 'inherit' }), spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1'], { stdio: 'inherit' })];
let stopping = false;
function stop() { if (stopping) return; stopping = true; children.forEach(c => c.kill('SIGTERM')); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
children.forEach(c => c.on('exit', code => { stop(); if (code) process.exitCode = code; }));

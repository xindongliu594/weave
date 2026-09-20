import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
const runtimeRoot = resolve('services/agent-runtime');
const require = createRequire(resolve(runtimeRoot, 'package.json'));
const hostPath = require.resolve('@deepseek-ai/dsh/package.json');
const pluginPath = require.resolve('@nanmicoder/dsh-agent-teams/package.json');
const host = JSON.parse(readFileSync(hostPath, 'utf8'));
const plugin = JSON.parse(readFileSync(pluginPath, 'utf8'));
const doctor = spawnSync(process.execPath, [resolve(dirname(pluginPath), 'scripts/doctor.mjs')], { cwd: runtimeRoot, encoding: 'utf8' });
console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch, dsh: host.version, agentTeams: plugin.version, packageCheck: doctor.stdout, executionBridgeReady: false }, null, 2));
// The upstream doctor may print FAIL while returning exit code 0.
if (doctor.error || doctor.status !== 0 || /FAIL:/.test(doctor.stdout)) process.exitCode = 1;

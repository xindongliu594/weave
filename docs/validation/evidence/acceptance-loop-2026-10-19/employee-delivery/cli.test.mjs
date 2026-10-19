// 独立 QA 测试：温度换算 CLI（cli.mjs）
// 仅使用 Node 内置模块：node:test、node:assert/strict、node:child_process
// 运行：node --test cli.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const CLI_PATH = path.join(path.dirname(__filename), 'cli.mjs');

// 以与测试文件同一目录的 cli.mjs 为目标启动子进程，保留 stdout/stderr 分离
function runCli(args) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: path.dirname(CLI_PATH),
    encoding: 'utf8',
    timeout: 20000,
  });
}

// 解析成功输出的单行 JSON，并断言基本结构
function parseSuccess(result, label) {
  assert.equal(result.error, undefined, `${label}: 子进程启动失败: ${result.error && result.error.message}`);
  assert.equal(result.signal, null, `${label}: 子进程被信号终止: ${result.signal}`);
  assert.equal(result.status, 0, `${label}: 期望退出码 0，实际 ${result.status}；stderr=${JSON.stringify(result.stderr)}`);
  assert.equal(result.stderr, '', `${label}: 成功时 stderr 应为空，实际 ${JSON.stringify(result.stderr)}`);

  const stdout = result.stdout;
  assert.ok(stdout.trim().length > 0, `${label}: stdout 不应为空`);

  let payload;
  assert.doesNotThrow(() => {
    payload = JSON.parse(stdout);
  }, `${label}: stdout 必须是合法 JSON，实际 ${JSON.stringify(stdout)}`);

  assert.equal(typeof payload, 'object', `${label}: 输出应为 JSON 对象`);
  assert.ok(payload !== null && !Array.isArray(payload), `${label}: 输出应为 JSON 对象而非 null/数组`);
  assert.deepEqual(
    Object.keys(payload).sort(),
    ['celsius', 'fahrenheit'],
    `${label}: JSON 键应恰为 celsius 与 fahrenheit，实际 ${JSON.stringify(Object.keys(payload))}`,
  );
  assert.equal(typeof payload.celsius, 'number', `${label}: celsius 应为数值，实际 ${typeof payload.celsius}`);
  assert.equal(typeof payload.fahrenheit, 'number', `${label}: fahrenheit 应为数值，实际 ${typeof payload.fahrenheit}`);
  assert.ok(Number.isFinite(payload.celsius), `${label}: celsius 应为有限数值`);
  assert.ok(Number.isFinite(payload.fahrenheit), `${label}: fahrenheit 应为有限数值`);
  return payload;
}

// 错误路径断言：退出码非零 + stderr 有提示 + stdout 不含 JSON
function assertFailure(args, label) {
  const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: path.dirname(CLI_PATH),
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.equal(result.error, undefined, `${label}: 子进程启动失败: ${result.error && result.error.message}`);
  assert.equal(result.signal, null, `${label}: 子进程被信号终止: ${result.signal}`);
  assert.notEqual(result.status, 0, `${label}: 期望非零退出码，实际 ${result.status}`);
  assert.equal(typeof result.status, 'number', `${label}: 应有数值退出码，实际 ${result.status}`);
  assert.ok(result.status > 0, `${label}: 退出码应为正的失败码（1~255），实际 ${result.status}`);
  assert.equal(typeof result.stderr, 'string', `${label}: stderr 应为字符串`);
  assert.ok(result.stderr.trim().length > 0, `${label}: 错误时 stderr 必须有提示文本，实际为空`);
  assert.ok(!result.stdout.includes('"fahrenheit"'), `${label}: 错误时 stdout 不应输出结果 JSON，实际 ${JSON.stringify(result.stdout)}`);
  assert.ok(!result.stdout.includes('"celsius"'), `${label}: 错误时 stdout 不应输出 celsius JSON，实际 ${JSON.stringify(result.stdout)}`);
  return result;
}

// ---------- 正常输入用例 ----------

test('0 摄氏度 -> 32 华氏度（stdout JSON 数值）', () => {
  const result = runCli(['0']);
  const payload = parseSuccess(result, 'cli 0');
  assert.equal(payload.celsius, 0);
  assert.equal(payload.fahrenheit, 32);
});

test('100 摄氏度 -> 212 华氏度（stdout JSON 数值）', () => {
  const result = runCli(['100']);
  const payload = parseSuccess(result, 'cli 100');
  assert.equal(payload.celsius, 100);
  assert.equal(payload.fahrenheit, 212);
});

test('-40 摄氏度 -> -40 华氏度（负数为合法输入）', () => {
  const result = runCli(['-40']);
  const payload = parseSuccess(result, 'cli -40');
  assert.equal(payload.celsius, -40);
  assert.equal(payload.fahrenheit, -40);
});

test('小数输入 36.6 摄氏度 -> 97.88 华氏度（stdout JSON 数值）', () => {
  const result = runCli(['36.6']);
  const payload = parseSuccess(result, 'cli 36.6');
  assert.equal(payload.celsius, 36.6);
  assert.equal(payload.fahrenheit, (36.6 * 9) / 5 + 32);
  assert.ok(Math.abs(payload.fahrenheit - 97.88) < 1e-9, `36.6°C 应约等于 97.88°F，实际 ${payload.fahrenheit}`);
});

test('小数输入 -0.5 摄氏度 -> 31.1 华氏度（负小数）', () => {
  const result = runCli(['-0.5']);
  const payload = parseSuccess(result, 'cli -0.5');
  assert.equal(payload.celsius, -0.5);
  assert.equal(payload.fahrenheit, (-0.5 * 9) / 5 + 32);
  assert.ok(Math.abs(payload.fahrenheit - 31.1) < 1e-9, `-0.5°C 应约等于 31.1°F，实际 ${payload.fahrenheit}`);
});

test('25 摄氏度 -> 77 华氏度（README 示例）', () => {
  const result = runCli(['25']);
  const payload = parseSuccess(result, 'cli 25');
  assert.equal(payload.celsius, 25);
  assert.equal(payload.fahrenheit, 77);
});

// ---------- 错误输入用例 ----------

test('缺失参数：非零退出码 + stderr 提示 + stdout 无 JSON', () => {
  const result = assertFailure([], 'cli（无参数）');
  assert.match(result.stderr, /参数/, 'stderr 应提示参数问题');
});

test('非数字参数 abc：非零退出码 + stderr 提示 + stdout 无 JSON', () => {
  const result = assertFailure(['abc'], 'cli abc');
  assert.match(result.stderr, /数字|无效|参数/, 'stderr 应提示参数不是有效数字');
});

test('非数字参数 (空字符串)：非零退出码 + stderr 提示', () => {
  const result = assertFailure([''], "cli ''");
  assert.ok(result.stderr.trim().length > 0, 'stderr 应提示非空错误信息');
});

test('非数字参数 NaN：非零退出码 + stderr 提示', () => {
  const result = assertFailure(['NaN'], 'cli NaN');
  assert.ok(result.stderr.trim().length > 0, 'stderr 应提示非空错误信息');
});

test('非数字参数 Infinity：非零退出码 + stderr 提示', () => {
  const result = assertFailure(['Infinity'], 'cli Infinity');
  assert.ok(result.stderr.trim().length > 0, 'stderr 应提示非空错误信息');
});

test('多个参数 1 2：非零退出码 + stderr 提示 + stdout 无 JSON', () => {
  const result = assertFailure(['1', '2'], 'cli 1 2');
  assert.match(result.stderr, /参数/, 'stderr 应提示参数个数问题');
});

test('多个参数 0 100：非零退出码 + stderr 提示', () => {
  const result = assertFailure(['0', '100'], 'cli 0 100');
  assert.match(result.stderr, /参数/, 'stderr 应提示参数个数问题');
});

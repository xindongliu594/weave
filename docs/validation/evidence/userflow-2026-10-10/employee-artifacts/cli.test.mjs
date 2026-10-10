// cli.test.mjs — 摄氏转华氏命令行工具的独立测试
//
// 由 QA（employee-3）独立编写，仅使用 Node 内置模块（node:test / node:assert /
// node:child_process / node:url / node:path），无第三方依赖。
//
// 覆盖内容：
//   - 三组必需换算：0→32、100→212、-40→-40
//   - 小数换算（按合理浮点容差验证）
//   - 非法输入拒绝：参数缺失、非数字、多参数、空字符串、纯空白
//     （均要求 stderr 有说明且退出码非零）
//   - 成功路径输出 JSON 结构与是否误写 stderr
//
// 运行方式：node --test cli.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CLI_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli.mjs');

// 合理浮点容差：换算结果量级最大约 212，1e-9 远大于 IEEE754 双精度误差。
const EPSILON = 1e-9;

/**
 * 运行 cli.mjs 并收集真实进程结果。
 * @param {string[]} args 传给 cli.mjs 的位置参数（逐项传递，不做 shell 拼接）
 * @returns {{status:number|null, signal:string|null, stdout:string, stderr:string}}
 */
function runCli(args) {
  const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: 'utf8',
  });

  assert.equal(
    result.error,
    undefined,
    `启动 cli.mjs 失败: ${result.error && result.error.message}`
  );

  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

/**
 * 独立按公式 F = C * 9 / 5 + 32 计算期望值（不读取实现内部逻辑）。
 * @param {number} celsius
 * @returns {number}
 */
function expectedFahrenheit(celsius) {
  return (celsius * 9) / 5 + 32;
}

/**
 * 断言成功运行：退出码 0、stdout 为合法 JSON、celsius/fahrenheit 符合容差、stderr 为空。
 * @param {string[]} args
 * @param {number} expectedCelsius
 * @param {number} expectedF 期望华氏值
 */
function assertSuccess(args, expectedCelsius, expectedF) {
  const r = runCli(args);

  assert.equal(
    r.status,
    0,
    `期望成功退出，实际 status=${r.status}, stderr=${JSON.stringify(r.stderr)}`
  );
  assert.equal(r.stderr, '', `成功路径不应写 stderr，实际: ${JSON.stringify(r.stderr)}`);

  let payload;
  assert.doesNotThrow(() => {
    payload = JSON.parse(r.stdout);
  }, `stdout 不是合法 JSON: ${JSON.stringify(r.stdout)}`);

  assert.equal(typeof payload, 'object', 'JSON 根应为对象');
  assert.ok(payload !== null, 'JSON 根不应为 null');
  assert.equal(
    Object.keys(payload).sort().join(','),
    'celsius,fahrenheit',
    `JSON 应恰含 celsius 与 fahrenheit 两个字段，实际: ${JSON.stringify(payload)}`
  );

  assert.equal(
    typeof payload.celsius,
    'number',
    `celsius 应为数值，实际: ${JSON.stringify(payload.celsius)}`
  );
  assert.equal(
    typeof payload.fahrenheit,
    'number',
    `fahrenheit 应为数值，实际: ${JSON.stringify(payload.fahrenheit)}`
  );

  assert.ok(
    Math.abs(payload.celsius - expectedCelsius) <= EPSILON,
    `celsius 期望 ${expectedCelsius}，实际 ${payload.celsius}`
  );
  assert.ok(
    Math.abs(payload.fahrenheit - expectedF) <= EPSILON,
    `fahrenheit 期望 ${expectedF}，实际 ${payload.fahrenheit}`
  );
}

/**
 * 断言非法输入被拒绝：退出码非零、stderr 有说明文字、stdout 无合法 JSON 结果。
 * @param {string[]} args
 * @param {string} label 用于失败信息
 */
function assertRejected(args, label) {
  const r = runCli(args);

  assert.notEqual(
    r.status,
    0,
    `${label}: 期望非零退出，实际 status=${r.status}, stdout=${JSON.stringify(r.stdout)}`
  );
  assert.ok(
    r.status !== null,
    `${label}: 进程不应被信号终止而缺少退出码（signal=${r.signal}）`
  );
  assert.ok(
    typeof r.stderr === 'string' && r.stderr.trim().length > 0,
    `${label}: 期望 stderr 有说明文字，实际 stderr=${JSON.stringify(r.stderr)}`
  );
  assert.equal(
    r.stdout.trim(),
    '',
    `${label}: 非法输入不应向 stdout 输出结果，实际 stdout=${JSON.stringify(r.stdout)}`
  );
}

// ---------------------------------------------------------------------------
// 1. 必需换算断言
// ---------------------------------------------------------------------------

test('0 摄氏度 → 32 华氏度', () => {
  assertSuccess(['0'], 0, 32);
});

test('100 摄氏度 → 212 华氏度', () => {
  assertSuccess(['100'], 100, 212);
});

test('-40 摄氏度 → -40 华氏度', () => {
  assertSuccess(['-40'], -40, -40);
});

test('示例值 25 摄氏度 → 77 华氏度', () => {
  assertSuccess(['25'], 25, 77);
});

// ---------------------------------------------------------------------------
// 2. 小数换算：按合理浮点容差验证
// ---------------------------------------------------------------------------

test('小数 36.6 摄氏度 → 97.88 华氏度（容差内）', () => {
  assertSuccess(['36.6'], 36.6, expectedFahrenheit(36.6));
});

test('负数小数 -12.5 摄氏度 → 9.5 华氏度（容差内）', () => {
  assertSuccess(['-12.5'], -12.5, expectedFahrenheit(-12.5));
});

test('小数 0.5 摄氏度 → 32.9 华氏度（容差内，非精确二进制小数）', () => {
  const c = 0.5;
  const expected = (c * 9) / 5 + 32; // 32.9
  assert.ok(
    Math.abs(expected - 32.9) <= EPSILON,
    '测试自身期望值应在容差内等于 32.9'
  );
  assertSuccess(['0.5'], c, expected);
});

// ---------------------------------------------------------------------------
// 3. 非法输入必须被拒绝（缺失 / 非数字 / 多参数 / 空字符串 / 纯空白）
// ---------------------------------------------------------------------------

test('参数缺失：非零退出且 stderr 有说明', () => {
  assertRejected([], '参数缺失');
});

test('非数字参数 "abc"：非零退出且 stderr 有说明', () => {
  assertRejected(['abc'], '非数字参数 abc');
});

test('非数字参数 "12abc"：非零退出且 stderr 有说明', () => {
  assertRejected(['12abc'], '非数字参数 12abc');
});

test('非数字参数 "NaN"：非零退出且 stderr 有说明', () => {
  assertRejected(['NaN'], '非数字参数 NaN');
});

test('非数字参数 "Infinity"：非零退出且 stderr 有说明', () => {
  assertRejected(['Infinity'], '非有限数字参数 Infinity');
});

test('多参数 "1 2"：非零退出且 stderr 有说明', () => {
  assertRejected(['1', '2'], '多参数 1 2');
});

test('多参数 "0 1 2"：非零退出且 stderr 有说明', () => {
  assertRejected(['0', '1', '2'], '多参数 0 1 2');
});

test('空字符串参数：必须被拒绝，不得当作摄氏 0 成功退出', () => {
  assertRejected([''], '空字符串参数');
});

test('纯空白参数 "   "：必须被拒绝，不得当作摄氏 0 成功退出', () => {
  assertRejected(['   '], '纯空白参数（三个空格）');
});

test('纯空白参数 "\\t"：必须被拒绝，不得当作摄氏 0 成功退出', () => {
  assertRejected(['\t'], '纯空白参数（制表符）');
});

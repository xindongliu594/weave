// help.test.mjs — cli.mjs 的 --help 帮助入口独立测试
//
// 由 QA（employee-3）独立编写，仅使用 Node 内置模块（node:test / node:assert /
// node:child_process / node:url / node:path），无第三方依赖。
// 本文件不读改写 cli.mjs、README.md、cli.test.mjs；只以子进程方式黑盒运行 cli.mjs。
//
// 覆盖内容：
//   1. --help 作为唯一参数：退出码 0、stdout 含完整用法 `node cli.mjs <celsius>`
//      与示例 `node cli.mjs 25`、不含换算 JSON、不写 stderr。
//   2. --help 带额外参数（node cli.mjs --help 25）：非零退出、stderr 有说明、
//      stdout 不输出帮助正文与换算 JSON。
//
// 运行方式：node --test help.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CLI_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli.mjs');

// 需求中的完整用法串（逐字匹配）。
const USAGE_LINE = 'node cli.mjs <celsius>';
// 需求要求的数字示例（逐字匹配）。
const EXAMPLE_25 = 'node cli.mjs 25';

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
 * 判断文本中是否含形如 {"celsius":..., "fahrenheit":...} 的换算 JSON 结果。
 * 用宽松正则，避免把帮助正文里的字段名描述误判为换算输出：
 * 只有出现 `"celsius"` 后跟数字字面量的 JSON 片段才算。
 * @param {string} text
 * @returns {boolean}
 */
function hasConversionJson(text) {
  return /"celsius"\s*:\s*-?\d/.test(text) || /"fahrenheit"\s*:\s*-?\d/.test(text);
}

// ---------------------------------------------------------------------------
// 1. 正常帮助：--help 唯一参数成功路径
// ---------------------------------------------------------------------------

test('--help 唯一参数：退出码 0、stdout 含完整用法与示例、不含换算 JSON', () => {
  const r = runCli(['--help']);

  // 退出码必须为 0（且不能是被信号杀死而缺失退出码）。
  assert.equal(r.signal, null, `--help 不应被信号终止，实际 signal=${r.signal}`);
  assert.equal(
    r.status,
    0,
    `期望 --help 退出码 0，实际 status=${r.status}, stderr=${JSON.stringify(r.stderr)}`
  );

  // 成功路径不应写 stderr。
  assert.equal(r.stderr, '', `--help 不应写 stderr，实际: ${JSON.stringify(r.stderr)}`);

  // stdout 必须含完整用法行 node cli.mjs <celsius>。
  assert.ok(
    r.stdout.includes(USAGE_LINE),
    `stdout 应含完整用法 ${JSON.stringify(USAGE_LINE)}，实际 stdout=${JSON.stringify(r.stdout)}`
  );

  // stdout 必须含数字示例 node cli.mjs 25。
  assert.ok(
    r.stdout.includes(EXAMPLE_25),
    `stdout 应含示例 ${JSON.stringify(EXAMPLE_25)}，实际 stdout=${JSON.stringify(r.stdout)}`
  );

  // 至少还有一个其它数字示例（“至少一个数字示例”的实际加强检查）。
  assert.ok(
    /node cli\.mjs -?\d+(\.\d+)?/.test(r.stdout.replace(EXAMPLE_25, '')),
    `stdout 应至少包含一个数字示例，实际 stdout=${JSON.stringify(r.stdout)}`
  );

  // 帮助输出不得是换算 JSON 结果。
  assert.equal(
    hasConversionJson(r.stdout),
    false,
    `--help 不应输出换算 JSON，实际 stdout=${JSON.stringify(r.stdout)}`
  );
  assert.equal(
    r.stdout.trim().startsWith('{'),
    false,
    `--help 输出不应以 JSON 对象开头，实际 stdout=${JSON.stringify(r.stdout)}`
  );
});

test('--help 唯一参数：多次运行结果稳定且不产生换算 JSON', () => {
  const first = runCli(['--help']);
  const second = runCli(['--help']);

  assert.equal(first.status, 0, `第一次 --help 应退出码 0，实际 ${first.status}`);
  assert.equal(second.status, 0, `第二次 --help 应退出码 0，实际 ${second.status}`);
  assert.equal(
    first.stdout,
    second.stdout,
    '同一参数两次运行的帮助输出应一致（确定性）'
  );
  assert.equal(
    hasConversionJson(second.stdout),
    false,
    `--help 输出不应含换算 JSON，实际 stdout=${JSON.stringify(second.stdout)}`
  );
});

// ---------------------------------------------------------------------------
// 2. 错误路径：--help 后带额外参数按多参数错误处理
// ---------------------------------------------------------------------------

test('--help 带额外参数（--help 25）：非零退出、stderr 说明且不输出帮助/换算结果', () => {
  const r = runCli(['--help', '25']);

  assert.equal(
    r.signal,
    null,
    `--help 25 不应被信号终止，实际 signal=${r.signal}`
  );
  assert.notEqual(
    r.status,
    0,
    `--help 25 期望非零退出，实际 status=${r.status}, stdout=${JSON.stringify(r.stdout)}`
  );
  assert.ok(
    r.status !== null,
    `--help 25 应给出退出码（signal=${r.signal}）`
  );

  // stderr 必须有说明文字。
  assert.ok(
    typeof r.stderr === 'string' && r.stderr.trim().length > 0,
    `--help 25 期望 stderr 有说明文字，实际 stderr=${JSON.stringify(r.stderr)}`
  );
  // 说明中应提到参数数量问题（本题为“两个参数”的多参数错误）。
  assert.ok(
    r.stderr.includes('2') || /多|仅需要|参数/.test(r.stderr),
    `stderr 应说明多参数错误，实际 stderr=${JSON.stringify(r.stderr)}`
  );

  // 不能被当成帮助成功路径：不输出帮助正文、不输出换算 JSON。
  assert.equal(
    r.stdout.includes(USAGE_LINE),
    false,
    `--help 25 是错误路径，不应向 stdout 输出帮助正文，实际 stdout=${JSON.stringify(r.stdout)}`
  );
  assert.equal(
    hasConversionJson(r.stdout),
    false,
    `--help 25 不应输出换算 JSON，实际 stdout=${JSON.stringify(r.stdout)}`
  );
});

test('--help 带额外参数（--help 25 99）：非零退出且 stderr 有说明', () => {
  const r = runCli(['--help', '25', '99']);

  assert.notEqual(
    r.status,
    0,
    `--help 25 99 期望非零退出，实际 status=${r.status}, stdout=${JSON.stringify(r.stdout)}`
  );
  assert.ok(
    typeof r.stderr === 'string' && r.stderr.trim().length > 0,
    `--help 25 99 期望 stderr 有说明文字，实际 stderr=${JSON.stringify(r.stderr)}`
  );
  assert.equal(
    r.stdout.trim(),
    '',
    `--help 25 99 不应向 stdout 输出内容，实际 stdout=${JSON.stringify(r.stdout)}`
  );
});

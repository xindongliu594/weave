// help.test.mjs — 摄氏转华氏命令行工具 `--help` 帮助入口的独立测试
//
// 独立编写：不修改也不依赖 cli.test.mjs 的实现细节，仅按批准的用户需求
// 断言 cli.mjs 的可观察行为。仅使用 Node 内置模块
// （node:test / node:assert / node:child_process / node:url / node:path），无第三方依赖。
//
// 覆盖内容：
//   1) 正常帮助（--help 唯一参数）
//      - 退出码 0
//      - stderr 为空
//      - stdout 含完整用法 "node cli.mjs <celsius>"
//      - stdout 含数字示例 "node cli.mjs 25"（并至少含一个 node cli.mjs <数字> 示例）
//      - stdout 不含换算 JSON：无任何可解析为换算结果的 JSON 行，
//        且帮助正文本身不是 JSON（帮助文本可为说明用途引用 JSON 格式字样）
//   2) 带额外参数的错误（--help 25 / --help abc / --help --verbose）
//      - 非零退出码
//      - stderr 有说明文字（含错误说明与用法指引）
//      - stdout 不输出帮助正文与换算结果
//
// 运行方式：node --test help.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CLI_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli.mjs');

// 需求要求的完整用法串与数字示例串（逐字比对，允许出现在多行帮助文本中）。
const REQUIRED_USAGE = 'node cli.mjs <celsius>';
const REQUIRED_EXAMPLE = 'node cli.mjs 25';

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
 * 判断 stdout 中是否存在“换算 JSON”输出行，即某一行可被解析为同时含
 * celsius 与 fahrenheit 两个数值字段的 JSON 对象（成功换算路径的可观察输出）。
 *
 * 说明：帮助文本可以用说明性文字引用 JSON 格式（例如输出格式说明行），
 * 这不是“输出换算 JSON”。因此这里只按“整行可解析为换算结果对象”判定，
 * 而不按关键字共现判定，避免把帮助说明误判为换算输出。
 *
 * @param {string} text
 * @returns {{found:boolean, line:string}} 命中的行（未命中为空串）
 */
function findConversionJsonLine(text) {
  if (typeof text !== 'string') return { found: false, line: '' };

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || !line.startsWith('{')) continue;

    try {
      const parsed = JSON.parse(line);
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        typeof parsed.celsius === 'number' &&
        typeof parsed.fahrenheit === 'number'
      ) {
        return { found: true, line };
      }
    } catch {
      // 不是合法 JSON 行，继续检查下一行。
    }
  }

  return { found: false, line: '' };
}

// ---------------------------------------------------------------------------
// 1. 正常帮助：--help 作为唯一参数必须成功
// ---------------------------------------------------------------------------

test('--help 唯一参数：退出码 0、stderr 为空、stdout 含完整用法与 node cli.mjs 25 示例、不含换算 JSON', () => {
  const r = runCli(['--help']);

  // 退出码 0，且不是被信号终止而缺失退出码。
  assert.equal(
    r.status,
    0,
    `--help 期望退出码 0，实际 status=${r.status}, signal=${r.signal}, stderr=${JSON.stringify(r.stderr)}`
  );
  assert.equal(
    r.stderr,
    '',
    `--help 成功路径不应写 stderr，实际 stderr=${JSON.stringify(r.stderr)}`
  );

  // stdout 非空，含完整用法串。
  assert.ok(
    r.stdout.trim().length > 0,
    `--help 应向 stdout 输出帮助文本，实际 stdout=${JSON.stringify(r.stdout)}`
  );
  assert.ok(
    r.stdout.includes(REQUIRED_USAGE),
    `--help 输出应含完整用法 ${JSON.stringify(REQUIRED_USAGE)}，实际 stdout=${JSON.stringify(r.stdout)}`
  );

  // stdout 含至少一个数字示例，且必须包含 node cli.mjs 25。
  assert.ok(
    r.stdout.includes(REQUIRED_EXAMPLE),
    `--help 输出应含示例 ${JSON.stringify(REQUIRED_EXAMPLE)}，实际 stdout=${JSON.stringify(r.stdout)}`
  );
  assert.ok(
    /node cli\.mjs -?\d+(\.\d+)?/.test(r.stdout),
    `--help 输出应至少含一个数字示例（node cli.mjs <数字>），实际 stdout=${JSON.stringify(r.stdout)}`
  );

  // 帮助路径不得输出换算 JSON 结果行。
  const hit = findConversionJsonLine(r.stdout);
  assert.equal(
    hit.found,
    false,
    `--help 不应输出换算 JSON，实际命中换算 JSON 行: ${JSON.stringify(hit.line)}`
  );

  // 帮助正文整体不应是机器可读的换算 JSON（即整段 stdout 不可被解析为换算结果对象）。
  let wholeIsJson = false;
  try {
    const parsed = JSON.parse(r.stdout);
    wholeIsJson =
      parsed !== null &&
      typeof parsed === 'object' &&
      typeof parsed.celsius === 'number' &&
      typeof parsed.fahrenheit === 'number';
  } catch {
    wholeIsJson = false;
  }
  assert.equal(
    wholeIsJson,
    false,
    `--help 的 stdout 不应整体为换算 JSON，实际 stdout=${JSON.stringify(r.stdout)}`
  );
});

// ---------------------------------------------------------------------------
// 2. --help 带额外参数：必须按多参数错误处理
// ---------------------------------------------------------------------------

for (const extra of ['25', 'abc', '--verbose']) {
  test(`--help 带额外参数 "${extra}"：向 stderr 说明并以非零退出码退出`, () => {
    const r = runCli(['--help', extra]);

    // 非零退出码，且进程正常结束（有退出码而非仅信号）。
    assert.notEqual(
      r.status,
      0,
      `--help ${extra} 期望非零退出码，实际 status=${r.status}, stdout=${JSON.stringify(r.stdout)}`
    );
    assert.ok(
      r.status !== null,
      `--help ${extra}: 进程不应被信号终止而缺少退出码（signal=${r.signal}）`
    );

    // stderr 有说明文字，并同时给出错误说明与用法指引。
    assert.ok(
      typeof r.stderr === 'string' && r.stderr.trim().length > 0,
      `--help ${extra}: 期望 stderr 有说明文字，实际 stderr=${JSON.stringify(r.stderr)}`
    );
    assert.ok(
      /错误/.test(r.stderr),
      `--help ${extra}: stderr 应含错误说明（"错误"），实际 stderr=${JSON.stringify(r.stderr)}`
    );
    assert.ok(
      r.stderr.includes('node cli.mjs'),
      `--help ${extra}: stderr 应含用法指引，实际 stderr=${JSON.stringify(r.stderr)}`
    );

    // 多参数错误路径不得向 stdout 输出帮助正文或换算结果。
    assert.equal(
      r.stdout.trim(),
      '',
      `--help ${extra}: 多参数错误不应向 stdout 输出内容，实际 stdout=${JSON.stringify(r.stdout)}`
    );
  });
}

#!/usr/bin/env node
/**
 * 摄氏温度转华氏温度命令行工具。
 *
 * 用法: node cli.mjs <celsius>
 *       node cli.mjs --help
 *
 * - 读取唯一的位置参数作为摄氏温度（允许负数与小数）
 * - 向 stdout 输出 JSON: {"celsius": <number>, "fahrenheit": <number>}
 * - 换算公式: F = C * 9 / 5 + 32
 * - --help 作为唯一参数时，向 stdout 输出用法与示例，退出码 0，不输出换算 JSON
 * - 参数缺失、非数字（含空字符串与纯空白）、多于一个参数时，
 *   向 stderr 输出说明并以非零退出码退出。
 */

const USAGE = '用法: node cli.mjs <celsius>';

const HELP_TEXT = [
  USAGE,
  '',
  '把摄氏温度换算为华氏温度。',
  '',
  '参数:',
  '  <celsius>   摄氏温度，唯一的位置参数，允许负数与小数。',
  '  --help      作为唯一参数时显示本帮助并退出（退出码 0）。',
  '',
  '输出:',
  '  成功时向 stdout 打印一行 JSON：{"celsius":<number>,"fahrenheit":<number>}',
  '',
  '示例:',
  '  node cli.mjs 25',
  '  node cli.mjs -40',
  '  node cli.mjs 36.6',
  '',
].join('\n');

/**
 * 校验并解析摄氏温度参数。
 * @param {string[]} args process.argv.slice(2)
 * @returns {{ ok: true, celsius: number } | { ok: false, message: string, code: number }}
 */
function parseCelsius(args) {
  if (args.length === 0) {
    return {
      ok: false,
      code: 1,
      message: `错误: 缺少摄氏温度参数。${USAGE}`,
    };
  }

  if (args.length > 1) {
    return {
      ok: false,
      code: 2,
      message: `错误: 需要且仅需要一个参数，但收到了 ${args.length} 个: ${args
        .map((a) => JSON.stringify(a))
        .join(', ')}。${USAGE}`,
    };
  }

  const raw = args[0];

  // 空字符串或纯空白不是合法的摄氏温度，不能被当作 0。
  if (raw.trim() === '') {
    return {
      ok: false,
      code: 3,
      message: `错误: 摄氏温度参数不能为空或纯空白（收到 ${JSON.stringify(
        raw
      )}）。${USAGE}`,
    };
  }

  const celsius = Number(raw);

  if (!Number.isFinite(celsius)) {
    return {
      ok: false,
      code: 3,
      message: `错误: 摄氏温度参数不是合法数字（收到 ${JSON.stringify(
        raw
      )}）。${USAGE}`,
    };
  }

  return { ok: true, celsius };
}

function main() {
  const args = process.argv.slice(2);

  // 仅当 --help 是唯一参数时显示帮助：退出码 0，只写 stdout，不输出换算 JSON。
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write(HELP_TEXT);
    return;
  }

  const parsed = parseCelsius(args);

  if (!parsed.ok) {
    process.stderr.write(`${parsed.message}\n`);
    process.exitCode = parsed.code;
    return;
  }

  const celsius = parsed.celsius;
  const fahrenheit = (celsius * 9) / 5 + 32;

  process.stdout.write(`${JSON.stringify({ celsius, fahrenheit })}\n`);
}

main();

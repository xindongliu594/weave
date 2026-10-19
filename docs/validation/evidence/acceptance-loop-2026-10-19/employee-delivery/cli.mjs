#!/usr/bin/env node
// 摄氏温度 -> 华氏温度换算 CLI（无第三方依赖）
// 用法: node cli.mjs <摄氏度数字>
// 输出: stdout 打印 JSON {"celsius":<输入>,"fahrenheit":<结果>}
// 错误: 缺失参数 / 非数字参数 / 多个参数 -> stderr 提示并以非零退出码结束

const NUMBER_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

function fail(message) {
  process.stderr.write(`错误：${message}\n`);
  process.stderr.write('用法: node cli.mjs <摄氏度数字>（允许负数与小数，例如 25、-40、36.6）\n');
  process.exitCode = 1;
}

function main(argv) {
  if (argv.length === 0) {
    fail('缺少参数，需要且仅需要一个数字型的摄氏度参数。');
    return;
  }
  if (argv.length > 1) {
    fail(`收到 ${argv.length} 个参数，只能传入一个摄氏度数字。`);
    return;
  }

  const raw = argv[0];
  if (typeof raw !== 'string' || !NUMBER_PATTERN.test(raw)) {
    fail(`参数 "${raw}" 不是有效的数字。`);
    return;
  }

  const celsius = Number(raw);
  if (!Number.isFinite(celsius)) {
    fail(`参数 "${raw}" 不是有限数字。`);
    return;
  }

  const fahrenheit = (celsius * 9) / 5 + 32;
  process.stdout.write(JSON.stringify({ celsius, fahrenheit }) + '\n');
}

main(process.argv.slice(2));

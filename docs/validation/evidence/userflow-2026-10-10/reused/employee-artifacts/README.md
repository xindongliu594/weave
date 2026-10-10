# 摄氏转华氏命令行工具

一个最小的 Node.js 命令行工具，把摄氏温度换算为华氏温度。仅使用 Node.js 内置能力，无第三方依赖。

## 环境要求

- Node.js（支持 ESM 的任意现代版本；本工具为标准 `cli.mjs` 模块，无需 `package.json`）

## 用法

```sh
node cli.mjs <celsius>
```

`<celsius>` 是唯一的位置参数，表示摄氏温度，允许负数与小数。

示例：

```sh
node cli.mjs 25
node cli.mjs 0
node cli.mjs 100
node cli.mjs -40
node cli.mjs 36.6
```

## 帮助

`--help` 作为**唯一**参数时，向标准输出（stdout）打印用法与示例，退出码为 `0`，且不输出换算 JSON：

```sh
node cli.mjs --help
```

输出内容包含完整用法与示例：

```
用法: node cli.mjs <celsius>

把摄氏温度换算为华氏温度。

参数:
  <celsius>   摄氏温度，唯一的位置参数，允许负数与小数。
  --help      作为唯一参数时显示本帮助并退出（退出码 0）。

输出:
  成功时向 stdout 打印一行 JSON：{"celsius":<number>,"fahrenheit":<number>}

示例:
  node cli.mjs 25
  node cli.mjs -40
  node cli.mjs 36.6
```

注意：`--help` 之后若还带有其他参数（例如 `node cli.mjs --help 25`），不再显示帮助，而是按“参数多于一个”的错误处理（见下节）。

## 输出格式

成功时向标准输出（stdout）打印一行 JSON，包含两个数值字段：

```json
{"celsius":25,"fahrenheit":77}
```

- `celsius`：输入解析后的摄氏温度（数值）
- `fahrenheit`：换算得到的华氏温度（数值）

换算公式：

```
F = C * 9 / 5 + 32
```

例如 `node cli.mjs 100` 输出：

```json
{"celsius":100,"fahrenheit":212}
```

## 错误处理

以下情况会向标准错误（stderr）输出说明文字，并以非零退出码退出，不向 stdout 输出 JSON：

| 情况 | 说明 |
| --- | --- |
| 参数缺失 | 未提供任何位置参数 |
| 参数非数字 | 参数无法解析为有限数字 |
| 参数为空或有纯空白 | 空字符串或仅含空白的参数不被接受，也不会被当作摄氏 0 |
| 参数多于一个 | 提供了两个及以上位置参数（包括 `--help` 后带额外参数） |

示例：

```console
$ node cli.mjs
错误: 缺少摄氏温度参数。用法: node cli.mjs <celsius>

$ node cli.mjs abc
错误: 摄氏温度参数不是合法数字（收到 "abc"）。用法: node cli.mjs <celsius>

$ node cli.mjs 1 2
错误: 需要且仅需要一个参数，但收到了 2 个: "1", "2"。用法: node cli.mjs <celsius>

$ node cli.mjs --help 25
错误: 需要且仅需要一个参数，但收到了 2 个: "--help", "25"。用法: node cli.mjs <celsius>
```

退出码：成功（含 `--help` 唯一参数）为 `0`；参数错误为非零（缺失为 `1`，多参数为 `2`，空/纯空白或非数字为 `3`）。

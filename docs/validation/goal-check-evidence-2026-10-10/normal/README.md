# sum.mjs

Node ESM 整数加法模块，导出 `sum(a, b)`，仅支持整数相加，返回结果。

## 环境要求

- Node.js 18+（自带 `node:test` 与 `node:assert`），无需安装任何依赖。

## 用法

```js
import { sum } from './sum.mjs';

sum(2, 3);    // 5
sum(-2, -3);  // -5
sum(0, 0);    // 0
```

非整数参数会抛出 `TypeError`。

## 运行测试

在本目录下执行：

```sh
node --test smoke.test.mjs
```

看到所有测试通过（`pass 7`，`fail 0`）即为成功。退出码 0 表示全部通过。

## 文件说明

- `sum.mjs` — 模块实现
- `smoke.test.mjs` — 冒烟测试（正数、负数、零覆盖）

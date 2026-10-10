/**
 * sum(a, b) — 整数相加。
 * 仅支持整数（Number.isInteger 为 true 的有限整数），返回 a + b。
 * 非整数输入抛出 TypeError。
 */
export function sum(a, b) {
  if (!Number.isInteger(a) || !Number.isInteger(b)) {
    throw new TypeError('sum(a, b) 仅支持整数');
  }
  return a + b;
}

export default sum;

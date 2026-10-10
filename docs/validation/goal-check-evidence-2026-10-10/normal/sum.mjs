/**
 * sum.mjs — 整数加法模块（Node ESM）
 * 导出 sum(a, b)：仅支持整数相加，返回两数之和。
 */

/**
 * 计算两个整数的和。
 * @param {number} a 整数
 * @param {number} b 整数
 * @returns {number} a + b
 * @throws {TypeError} 当参数不是整数时抛出
 */
export function sum(a, b) {
  if (!Number.isInteger(a) || !Number.isInteger(b)) {
    throw new TypeError('sum() 仅支持整数参数');
  }
  return a + b;
}

export default sum;

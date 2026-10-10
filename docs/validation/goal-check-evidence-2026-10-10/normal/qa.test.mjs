// qa.test.mjs — 独立 QA 测试（不引用开发员工结论）
// 仅从 sum.mjs 的公开导出行为出发，独立验证正数、负数、零的整数加法。
import test from 'node:test';
import assert from 'node:assert/strict';
import { sum } from './sum.mjs';

test('QA-正数：正整数相加保持正数且结果正确', () => {
  assert.equal(sum(1, 1), 2);
  assert.equal(sum(7, 8), 15);
  assert.equal(sum(999, 1), 1000);
  assert.ok(sum(4, 5) > 0);
});

test('QA-负数：负整数相加为负且结果正确', () => {
  assert.equal(sum(-1, -1), -2);
  assert.equal(sum(-9, -11), -20);
  assert.equal(sum(-100, -1), -101);
  assert.ok(sum(-4, -5) < 0);
});

test('QA-零：零元素的整数加法恒等性质', () => {
  assert.equal(sum(0, 0), 0);
  assert.equal(sum(0, 13), 13);
  assert.equal(sum(13, 0), 13);
  assert.equal(sum(0, -13), -13);
  assert.equal(sum(-13, 0), -13);
});

test('QA-混合与交换律：正负相加及参数顺序不影响结果', () => {
  assert.equal(sum(-8, 3), -5);
  assert.equal(sum(3, -8), -5);
  assert.equal(sum(-3, 3), 0);
  assert.equal(sum(12, 30), sum(30, 12));
});

test('QA-非整数输入被拒绝（TypeError）', () => {
  assert.throws(() => sum(0.5, 0), TypeError);
  assert.throws(() => sum(0, 2.5), TypeError);
  assert.throws(() => sum(-1.25, 1), TypeError);
  assert.throws(() => sum('1', 2), TypeError);
  assert.throws(() => sum(1, null), TypeError);
});

test('QA-返回值类型为 number', () => {
  assert.equal(typeof sum(2, 3), 'number');
  assert.equal(typeof sum(-2, -3), 'number');
  assert.equal(typeof sum(0, 0), 'number');
});

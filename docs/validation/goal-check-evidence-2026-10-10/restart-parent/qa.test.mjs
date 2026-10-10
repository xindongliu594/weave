// 独立 QA 测试：不引用开发员工结论，仅依据 sum.mjs 的公开导出 sum(a,b) 行为自行设计用例。
import test from 'node:test';
import assert from 'node:assert/strict';
import { sum } from './sum.mjs';

test('QA 正数整数相加', () => {
  assert.equal(sum(1, 1), 2);
  assert.equal(sum(7, 35), 42);
  assert.equal(sum(1000, 2000), 3000);
  assert.equal(sum(0, 9), 9);
});

test('QA 负数整数相加', () => {
  assert.equal(sum(-1, -1), -2);
  assert.equal(sum(-8, -34), -42);
  assert.equal(sum(-1000, -2000), -3000);
  assert.equal(sum(-9, 9), 0);
});

test('QA 零参与相加', () => {
  assert.equal(sum(0, 0), 0);
  assert.equal(sum(0, 5), 5);
  assert.equal(sum(5, 0), 5);
  assert.equal(sum(0, -5), -5);
});

test('QA 返回值与整数输入的类型一致性', () => {
  assert.equal(typeof sum(3, 4), 'number');
  assert.ok(Number.isInteger(sum(3, 4)));
  assert.ok(Number.isInteger(sum(-3, -4)));
  assert.ok(Number.isInteger(sum(0, 0)));
});

test('QA 非整数输入被拒绝（TypeError）', () => {
  assert.throws(() => sum(1.5, 2), TypeError);
  assert.throws(() => sum(2, -0.5), TypeError);
  assert.throws(() => sum('1', 2), TypeError);
  assert.throws(() => sum(1, NaN), TypeError);
  assert.throws(() => sum(Infinity, 1), TypeError);
});

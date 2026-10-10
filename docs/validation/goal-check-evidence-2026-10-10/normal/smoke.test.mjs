import test from 'node:test';
import assert from 'node:assert/strict';
import { sum } from './sum.mjs';

test('正数相加：2 + 3 = 5', () => {
  assert.equal(sum(2, 3), 5);
});

test('正数相加：100 + 250 = 350', () => {
  assert.equal(sum(100, 250), 350);
});

test('负数相加：-2 + -3 = -5', () => {
  assert.equal(sum(-2, -3), -5);
});

test('负数与正数相加：-10 + 4 = -6', () => {
  assert.equal(sum(-10, 4), -6);
});

test('零：0 + 0 = 0', () => {
  assert.equal(sum(0, 0), 0);
});

test('零与其他整数：0 + 7 = 7，-7 + 0 = -7', () => {
  assert.equal(sum(0, 7), 7);
  assert.equal(sum(-7, 0), -7);
});

test('非整数参数抛出 TypeError', () => {
  assert.throws(() => sum(1.5, 1), TypeError);
  assert.throws(() => sum(1, '2'), TypeError);
});

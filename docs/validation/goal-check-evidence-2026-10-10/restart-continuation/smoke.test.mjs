import test from 'node:test';
import assert from 'node:assert/strict';
import { sum } from './sum.mjs';

test('正数相加', () => {
  assert.equal(sum(2, 3), 5);
  assert.equal(sum(100, 250), 350);
});

test('负数相加', () => {
  assert.equal(sum(-2, -3), -5);
  assert.equal(sum(-10, 4), -6);
});

test('零的相加', () => {
  assert.equal(sum(0, 0), 0);
  assert.equal(sum(0, 7), 7);
  assert.equal(sum(-7, 0), -7);
});

test('非整数输入抛出 TypeError', () => {
  assert.throws(() => sum(1.5, 2), TypeError);
});

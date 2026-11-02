import test from 'node:test';
import assert from 'node:assert/strict';
import { productFlowSchema } from './helpers/product-flow-support.ts';

test('product-flow schemas remain unique within a fixed clock tick', t => {
  t.mock.method(Date, 'now', () => 1234);
  const schemas = Array.from({ length: 1000 }, () => productFlowSchema({ query: async () => ({}) } as any).name);
  assert.equal(new Set(schemas).size, schemas.length);
  assert.ok(schemas.every(name => /^flow_[a-f0-9]{32}$/.test(name)));
});

test('schema cleanup drops only a successfully created schema and relinquishes ownership', async () => {
  const queries: string[] = [];
  let failCreate = true;
  const schema = productFlowSchema({ query: async (sql: string) => {
    queries.push(sql);
    if (failCreate) throw Error('CREATE denied');
  } } as any);
  await schema.drop();
  assert.deepEqual(queries, []);
  await assert.rejects(schema.create(), /CREATE denied/);
  await schema.drop();
  assert.deepEqual(queries, ['CREATE SCHEMA ' + schema.name]);
  failCreate = false;
  await schema.create();
  await schema.drop();
  await schema.drop();
  assert.deepEqual(queries, ['CREATE SCHEMA ' + schema.name, 'CREATE SCHEMA ' + schema.name, 'DROP SCHEMA ' + schema.name + ' CASCADE']);
});

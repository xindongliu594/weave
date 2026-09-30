import { readFileSync, writeFileSync } from 'node:fs';
import { totalCents } from './lib/money.mjs';
const orders = JSON.parse(readFileSync(new URL('./inputs/orders.json', import.meta.url), 'utf8'));
const report = { orderCount: orders.length, totalCents: totalCents(orders) };
writeFileSync(new URL('./report.json', import.meta.url), JSON.stringify(report) + '\n');
console.log(JSON.stringify(report));

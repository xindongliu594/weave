// Direct node:test entry covers the native group; the integration runner expands
// this legacy path to all six isolated groups (19 scenarios).
import { registerProductFlowTests } from './helpers/product-flow-support.ts';

registerProductFlowTests('native');

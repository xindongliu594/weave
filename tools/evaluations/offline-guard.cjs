// The controlled evaluator has no legitimate network use, including telemetry.
const deny = () => { throw new Error('OFFLINE_EVALUATION_NETWORK_DISABLED'); };
for (const [module, names] of [
  ['node:http', ['request', 'get']], ['node:https', ['request', 'get']],
  ['node:net', ['connect', 'createConnection']], ['node:tls', ['connect']],
  ['node:dgram', ['createSocket']], ['node:dns', ['lookup', 'resolve']],
]) {
  const api = require(module);
  for (const name of names) api[name] = deny;
}
require('node:net').Socket.prototype.connect = deny;
globalThis.fetch = deny;
require('node:module').syncBuiltinESMExports();

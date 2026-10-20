export function evidenceReasons(evidence) {
  const reasons = [];
  if (evidence.qa?.status !== 'passed' || evidence.qa?.artifactDigest !== evidence.artifact?.digest) reasons.push('missing-qa');
  if (evidence.artifact?.digest !== evidence.artifact?.expectedDigest) reasons.push('stale-artifact');
  if (evidence.operations?.some(op => !['read', 'write', 'deliver'].includes(op.kind))) reasons.push('unknown-operation');
  if (!Array.isArray(evidence.operations) || new Set(evidence.operations.map(op => op.actionId)).size !== evidence.operations.length) reasons.push('duplicate-action');
  return reasons.sort();
}
export function evaluateEvidence(evidence, expected) {
  const actual = evidenceReasons(evidence);
  const pass = JSON.stringify(actual) === JSON.stringify([...expected.reasons].sort()) && expected.accepted === (actual.length === 0);
  return { pass, score: pass ? 1 : 0, reason: pass ? 'Synthetic evidence invariant matched' : `Evidence invariant mismatch: ${actual.join(',')}` };
}
export default function assertion(output, context) {
  return evaluateEvidence(typeof output === 'string' ? JSON.parse(output) : output, context.vars.expected);
}

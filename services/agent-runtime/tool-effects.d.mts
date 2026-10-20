import type { EffectContract } from '../../packages/contracts/tool-effects.ts';

/** Bounded strict JSON digest; this does not grant execution authority. */
export function effectDigest(value: unknown): string;
/** Detached, deeply immutable validated metadata. Source review and current authorization are separate checks. */
export function validateEffectContract(value: unknown): EffectContract;

/** Definition metadata is not an approval, implementation attestation, or execution grant. */
import type { EffectContract } from '../../packages/contracts/tool-effects.ts';
import type {RuntimeOperations} from '../../apps/api/src/tool-operations.ts';
export type EffectContractSnapshot = { effectContractVersion: 1; effectContracts: EffectContract[] };
export interface ToolEffectAuthority {
  assertSnapshot(snapshot: EffectContractSnapshot, signal?: AbortSignal): Promise<void>;
  withAdmission<T>(contract: EffectContract, invoke: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T>;
  runtimeOperations?:RuntimeOperations;
  assertRuntimeBindings?(input:{queryKnowledge:unknown;snapshot:unknown}):void|Promise<void>;
}
export interface CapturedToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly definitionSha256: string;
  readonly effectContract: Readonly<{ status: 'unreviewed'; effect: 'unknown'; definitionSha256: string }>;
  /** Once a mismatch is observed this capture stays invalid. */
  matches(actual: unknown): boolean;
}
/** Captures the final DSH registered object; functions use identity checks, never source hashes. */
export function captureToolDefinition(definition: unknown, registrationBinding: string): CapturedToolDefinition;
export function indexEffectContracts(snapshot: unknown): Map<string, EffectContract> | undefined;
export function boundEffectSummary(binding: CapturedToolDefinition, contract: EffectContract | undefined): Readonly<{
  status: 'reviewed'; effect: EffectContract['effect']; definitionSha256: string; contractSha256: string; namespace: string; sourceVersion: string;
}> | undefined;

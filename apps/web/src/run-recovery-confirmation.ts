import { recoveryConditionsAllow, recoveryConditionsResultKey, type RecoveryConditions } from './RecoveryConditions.tsx';

export type RunRecoveryContext = {
 runId: string; version: number; key: string; retainUncertainCosts: boolean; acknowledged: boolean;
 allowResume: boolean; allowRetry: boolean;
 checkpointId?: string;
};
export type RunRecoveryIntent = Pick<RunRecoveryContext, 'runId' | 'version' | 'key' | 'retainUncertainCosts' | 'acknowledged' | 'checkpointId'> & { resume: boolean };

/** An intent is local consent, never a retry ticket. Each confirmation rechecks the backend. */
export function createRunRecoveryConfirmation() {
 let intent: RunRecoveryIntent | undefined, inFlight = false;
 const sameConsent = (value: RunRecoveryIntent, current: RunRecoveryContext) => value.runId === current.runId
  && value.version === current.version && value.key === current.key
  && value.retainUncertainCosts === current.retainUncertainCosts && value.acknowledged === current.acknowledged
  && value.checkpointId === (value.resume ? current.checkpointId : undefined);
 const matches = (value: RunRecoveryIntent, current: RunRecoveryContext) => sameConsent(value,current)
  && (value.resume ? current.allowResume : current.allowRetry);
 return {
  get intent() { return intent; },
  get inFlight() { return inFlight; },
  // A periodic ledger refresh temporarily disables actions. Keep the visible
  // confirmation until its actual identity, ledger or choices change.
  sync(current: RunRecoveryContext) { if(intent && !sameConsent(intent, current)) intent = undefined; },
  open(current: RunRecoveryContext, resume: boolean) {
   if(inFlight || !(resume ? current.allowResume : current.allowRetry)) return false;
   intent = { runId: current.runId, version: current.version, key: current.key, retainUncertainCosts: current.retainUncertainCosts, acknowledged: current.acknowledged, resume, ...(resume&&current.checkpointId?{checkpointId:current.checkpointId}:{}) };
   return true;
  },
  cancel() { intent = undefined; },
  async confirm(callbacks: {
   current: () => RunRecoveryContext;
   check: (value: RunRecoveryIntent) => Promise<RecoveryConditions | undefined>;
   dispatch: (value: RunRecoveryIntent) => Promise<{ id: string }>;
   navigate: (runId: string) => void;
  }) {
   const selected = intent;
   if(inFlight || !selected) return false;
   if(!sameConsent(selected, callbacks.current())) { intent = undefined; return false; }
   if(!matches(selected, callbacks.current())) return false;
   inFlight = true;
   try {
    const checked = await callbacks.check(selected);
    if(intent !== selected || !matches(selected, callbacks.current())
     || !recoveryConditionsAllow(checked, checked && recoveryConditionsResultKey(checked), selected.key, selected.resume)) {
     if(intent === selected) intent = undefined;
     return false;
    }
    const result = await callbacks.dispatch(selected);
    // A route change, cancellation, or changed ledger cannot send an old result
    // to the new page. A submitted operation is never blindly re-dispatched.
    if(intent === selected && matches(selected, callbacks.current())) callbacks.navigate(result.id);
    return true;
   } finally { if(intent === selected)intent = undefined; inFlight = false; }
  },
 };
}

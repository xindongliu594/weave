export type RelayRoute = { id: string; name: string; wireModel: string; baseUrl: string; apiKey: string; inputRate: number; outputRate: number; maxOutputTokens: number; contextBytes?: number };
export type RuntimeUsage = { id: string; modelId: string; inputTokens: number; outputTokens: number; cost: number };
export class OpenAiCompatibleAdapter {
  constructor(input: { routes: RelayRoute[]; maxBudget: number; onUsage?: (usage: RuntimeUsage) => void; onError?: (error: unknown) => void });
}

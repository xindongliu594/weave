export type CompletionProtocol = 'chat-completions' | 'responses';
export function completionRequest(protocol: CompletionProtocol | undefined, chatBody: Record<string, any>): {path: '/chat/completions' | '/responses'; body: Record<string, any>};
export function completionUsage(protocol: CompletionProtocol | undefined, payload: any): any;
export function completionResponse(protocol: CompletionProtocol | undefined, payload: any): any;
export function conversationHeaders(baseUrl: string, stableSession?: string): Record<string, string>;

export function tokenize(text: string): string[];
export function chunkDocument(id: string, version: number, content: string): any[];
export function searchKnowledge(chunks: any[], query: string, limit?: number): any[];

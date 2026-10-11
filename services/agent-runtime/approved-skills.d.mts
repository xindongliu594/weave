export function approvedSkills(manifest: unknown, employee?: { id: string; tools: string[] }): {
  name: string; description: string; content: string;
  evidence: { documentId: string; version: number; sha256: string };
}[];
export function installApprovedSkills(ctx: any, mount: (name: string, config?: unknown) => Promise<void>, options: any): Promise<void>;
export function companySkills(manifest: unknown, employee?: { id: string; tools: string[] }): {name:string;description:string;evidence:{documentId:string;version:number;sha256:string}}[];

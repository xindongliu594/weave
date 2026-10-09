import { createHash } from 'node:crypto';

/** Only explicitly approved methods become instructions; ordinary knowledge never does. */
export function approvedSkills(manifest, employee) {
  if (!Array.isArray(employee?.tools) || !employee.tools.includes('knowledge_read') || !employee.tools.includes('knowledge_search')) return [];
  const inputs = (manifest?.runInputs ?? []).filter(input => input.skillName && input.agentIds?.includes(employee.id));
  const names = new Set();
  return inputs.map(input => {
    const chunk = input.chunks?.[0];
    if (manifest.format !== 'document-versions-v2' || typeof input.title !== 'string' || !input.title.trim() || input.title.length > 200 ||
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.skillName) || input.skillName.length > 80 || names.has(input.skillName) ||
        !Array.isArray(input.chunks) || input.chunks.length !== 1 || chunk?.documentId !== input.documentId || chunk.version !== 1 ||
        typeof chunk.content !== 'string' || !chunk.content.trim() || chunk.content.length > 16000 ||
        createHash('sha256').update(chunk.content).digest('hex') !== chunk.sha256) throw Error('APPROVED_SKILL_INVALID: 工作方法的固定版本或内容校验失败');
    names.add(input.skillName);
    return { name: input.skillName, description: input.title, source: 'department-approved',
      content: chunk.content, invocation: { modelInvocable: true, userInvocable: false },
      resourceBase: { kind: 'opaque', description: '这是已批准的固定工作方法。附属资料须通过获授权的知识或文件工具读取；不能扩大工具、预算或验收范围。' },
      evidence: { documentId: input.documentId, version: chunk.version, sha256: chunk.sha256 } };
  });
}

/** Thin authorization adapter; registry, catalog and loader belong to DSH. */
export async function installApprovedSkills(ctx, mount, { manifest, employee, agent, archive }) {
  const skills = approvedSkills(manifest, employee);
  if (!skills.length) return;
  await mount('@deepseek-ai/dsh-skill');
  for (const { evidence, ...definition } of skills) ctx.skills.register(definition);
  await mount('@deepseek-ai/dsh-tool-skill', { catalogDescriptionMaxLength: 200 });
  ctx.tools.guard(exec => exec.name === 'skill' && (exec.agent !== agent || ctx.agents.get(agent.id) !== agent) ? 'SKILL_PERMISSION_DENIED: 工作方法只允许获授权的当前员工读取' : undefined);
  ctx.on('tools/result', (exec, result) => {
    if (exec.name !== 'skill' || result.isError) return;
    const skill = skills.find(item => item.name === exec.arguments.name);
    if (skill) archive?.append('skill/loaded', { agentId: employee.id, name: skill.name, ...skill.evidence }, { sessionId: agent.id, callId: exec.callId });
  });
  archive?.append('skill/catalog', { agentId: employee.id, skills: skills.map(({ name, evidence }) => ({ name, ...evidence })) }, { sessionId: agent.id });
}

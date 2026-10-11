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

/** The catalog holds immutable references; DSH loads the selected body lazily. */
export function companySkills(manifest, employee) {
  if(manifest?.format!=='document-versions-v2'||!employee?.tools?.includes('knowledge_search')||!employee.tools.includes('knowledge_read'))return [];
  const allowed=new Set(manifest.agentDocuments?.[employee.id]??[]);
  const documents=(manifest.documents??[]).filter(doc=>allowed.has(doc.documentId)&&doc.source?.skillName);
  if(documents.length>50)throw Error('COMPANY_SKILL_LIMIT: 此员工获授权的公司工作方法超过 50 个，请缩小资料范围');
  return documents.map(doc=>{
    if(typeof doc.documentId!=='string'||typeof doc.title!=='string'||!doc.title.trim()||doc.title.length>200||!Number.isInteger(doc.version)||doc.version<1||!/^[a-f0-9]{64}$/.test(doc.sha256)||typeof doc.source.skillName!=='string'||doc.source.skillName.length>80||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(doc.source.skillName))throw Error('APPROVED_SKILL_INVALID: 公司工作方法目录版本校验失败');
    return {name:`kb-${createHash('sha256').update(doc.documentId).digest('hex').slice(0,12)}-${doc.source.skillName.slice(0,56).replace(/-$/,'')}`,
      description:doc.title,source:'company-approved',provider:'weiwu-company',rank:500,
      invocation:{modelInvocable:true,userInvocable:false},
      resourceBase:{kind:'opaque',description:'固定版本的批准公司方法；附属资料按员工授权读取，不能扩大目标、权限或预算。'},
      evidence:{documentId:doc.documentId,version:doc.version,sha256:doc.sha256}};
  });
}

/** Thin authorization adapter; registry, catalog and loader belong to DSH. */
export async function installApprovedSkills(ctx, mount, { manifest, employee, agent, archive, queryKnowledge }) {
  const skills = approvedSkills(manifest, employee);
  const company=companySkills(manifest,employee),catalog=[...skills,...company];
  if (!catalog.length) return;
  if(new Set(catalog.map(item=>item.name)).size!==catalog.length)throw Error('APPROVED_SKILL_INVALID: 批准工作方法名称冲突');
  await mount('@deepseek-ai/dsh-skill');
  for (const { evidence, ...definition } of skills) ctx.skills.register(definition);
  if(company.length)ctx.skills.registerProvider(()=>({name:'weiwu-company',list:async()=>company.map(({evidence,...summary})=>({...summary,locator:evidence})),
    get:async(candidate,{signal})=>{
      signal?.throwIfAborted();
      const method=company.find(item=>item.name===candidate.name);
      if(!method||!queryKnowledge)throw Error('KNOWLEDGE_SERVICE_UNAVAILABLE: 公司方法加载服务不可用');
      const loaded=await queryKnowledge(manifest,employee.id,'skill',method.evidence.documentId);
      signal?.throwIfAborted();
      if(!loaded||loaded.documentId!==method.evidence.documentId||loaded.version!==method.evidence.version||loaded.sha256!==method.evidence.sha256||typeof loaded.content!=='string'||!loaded.content.trim()||loaded.content.length>16000||createHash('sha256').update(loaded.content).digest('hex')!==method.evidence.sha256)throw Error('APPROVED_SKILL_INVALID: 公司工作方法正文或固定版本校验失败');
      const {evidence,rank,...summary}=method;return {...summary,content:loaded.content};
    }}));
  await mount('@deepseek-ai/dsh-tool-skill', { catalogDescriptionMaxLength: 200 });
  ctx.tools.guard(exec => exec.name === 'skill' && (exec.agent !== agent || ctx.agents.get(agent.id) !== agent) ? 'SKILL_PERMISSION_DENIED: 工作方法只允许获授权的当前员工读取' : undefined);
  ctx.on('tools/result', (exec, result) => {
    if (exec.name !== 'skill' || result.isError) return;
    const skill = catalog.find(item => item.name === exec.arguments.name);
    if (skill) archive?.append('skill/loaded', { agentId: employee.id, name: skill.name, ...skill.evidence }, { sessionId: agent.id, callId: exec.callId });
  });
  archive?.append('skill/catalog', { agentId: employee.id, skills: catalog.map(({ name, evidence }) => ({ name, ...evidence })) }, { sessionId: agent.id });
}

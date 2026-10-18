import { createHash } from 'node:crypto';
import { isNativeToolName } from '../../packages/contracts/native-tool-ids.mjs';
import { isArtifactPath } from '../../packages/contracts/task-contracts.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const field = value => typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(value);
export function validateNativeManifest(value) {
  const bad = () => { throw Error('NATIVE_MANIFEST_INVALID: 原生插件安装记录不完整或不兼容'); };
  if (!value || value.format !== 'dsh-native-tools-v1' || typeof value.namespace !== 'string' || !/^[a-z][a-z0-9_]{0,19}$/.test(value.namespace) || value.namespace.includes('__') ||
      typeof value.package !== 'string' || !/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/.test(value.package) ||
      typeof value.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(value.version) ||
      value.dshVersion !== '0.1.5-rc.1' || !sha(value.lockSha256) ||
      !['npm', 'company'].includes(value.source?.kind) || typeof value.source.reference !== 'string' || value.source.reference.length > 500 ||
      !value.config || Array.isArray(value.config) || typeof value.config !== 'object' ||
      !sha(value.bundle?.sha256) || !sha(value.bundle?.codeSha256) || !sha(value.bundle?.metadataSha256) ||
      !Number.isSafeInteger(value.bundle?.bytes) || value.bundle.bytes < 1 || value.bundle.bytes > 4 * 1024 * 1024 ||
      !Array.isArray(value.tools) || !value.tools.length || value.tools.length > 48 || Buffer.byteLength(JSON.stringify(value)) > 256 * 1024) bad();
  const names = new Set();
  for (const tool of value.tools) {
    if (!isNativeToolName(tool.name) || tool.name !== `plugin__${value.namespace}__${tool.originalName}` || names.has(tool.name) ||
        typeof tool.description !== 'string' || tool.description.length > 12000 || tool.parameters?.type !== 'object' ||
        !Array.isArray(tool.files?.read) || !Array.isArray(tool.files?.write) ||
        tool.files.read.some(item => !field(item)) || tool.files.write.some(item => !field(item) && !(field(item?.field) && field(item?.fallback)))) bad();
    names.add(tool.name);
  }
  return value;
}
export function nativeManifestId(manifest) { return digest(JSON.stringify(canonical(validateNativeManifest(manifest)))); }
export function nativeToolBinding(snapshot, name) {
  const matches = [];
  for (const binding of snapshot.nativeCapabilities ?? []) {
    if (binding.id !== nativeManifestId(binding.manifest)) throw Error('NATIVE_VERSION_MISMATCH: 固定插件版本校验失败');
    if (binding.manifest.tools.some(tool => tool.name === name)) matches.push(binding);
  }
  if (matches.length > 1) throw Error('NATIVE_TOOL_CONFLICT: 工具注册冲突');
  if (!matches.length) throw Error('NATIVE_TOOL_UNAVAILABLE: 工具没有固定安装版本');
  return matches[0];
}
export function nativeFileAccess(tool, args) {
  const resolve = entry => typeof entry === 'string' ? args[entry] : args[entry.field] ?? args[entry.fallback];
  const paths = entries => [...new Set(entries.map(entry => {
    const value = resolve(entry);
    if (!isArtifactPath(value) || /[:*?]/.test(value)) throw Object.assign(Error('NATIVE_PATH_DENIED: 插件只接受已声明的工作区相对文件路径'), { notExecuted: true });
    return value;
  }))];
  return { read: paths(tool.files.read), write: paths(tool.files.write) };
}
export function assertNativeTaskAccess({agents,tasks,nativeCapabilities}) {
  for(const task of tasks){
    const employee=agents.find(agent=>agent.id===task.assigneeId),tools=employee?.tools??[];
    const native=tools.filter(isNativeToolName).map(name=>nativeToolBinding({nativeCapabilities},name).manifest.tools.find(tool=>tool.name===name));
    if(!native.length)continue;
    for(const item of [...(task.inputs??[]),...(task.outputs??[])])if(!isArtifactPath(item.path)||/[:*?]/.test(item.path))throw Error('NATIVE_PATH_DENIED: 插件任务必须指定普通相对文件路径');
    if(task.inputs?.length&&!tools.includes('filesystem')&&!native.some(tool=>tool.files.read.length))throw Error('NATIVE_TASK_ACCESS: 任务输入缺少已注册的文件读取工具');
    if(task.outputs?.length&&!tools.some(name=>['artifact_write','terminal','terminal_test'].includes(name))&&!native.some(tool=>tool.files.write.length))throw Error('NATIVE_TASK_ACCESS: 任务输出缺少已注册的文件写入工具');
  }
}

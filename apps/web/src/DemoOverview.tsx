import { ArrowRight, CheckCircle2, Code2, ShieldCheck, Users } from 'lucide-react';

export function DemoOverview({ onOpen }: { onOpen: () => void }) {
  return <section className="panel padded demo-overview">
    <div className="section-title"><h2><Code2 size={20}/> 体验团队完成一个 Todo API</h2><span className="tag green">本地演示</span></div>
    <p>经理协调、开发员工实现、测试员工独立验收。代码会写入演示工作区，接口测试会实际执行。</p>
    <ol className="demo-steps">
      <li><Users size={18}/><div><strong>查看团队与方案</strong><span>已准备 3 位员工和开发、验收两项任务。</span></div></li>
      <li><ShieldCheck size={18}/><div><strong>批准项目和测试操作</strong><span>批准方案后，在执行页逐次批准两条 Node 测试命令。</span></div></li>
      <li><CheckCircle2 size={18}/><div><strong>检查并下载成果</strong><span>查看 Todo 代码、运行说明、6 项独立接口验收和完整执行记录。</span></div></li>
    </ol>
    <button className="primary" onClick={onOpen}>查看 Todo 示例方案 <ArrowRight size={16}/></button>
    <p className="subcopy">使用固定响应模型，没有真实模型费用。可体验分工、审批和交付流程；真实模型的完成质量留待后续验证。</p>
  </section>;
}

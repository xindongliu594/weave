# SkillX 隔离提炼试验

一次性试验，固定于 JJ 的 `skillx-pilot-20261015` 目录及一个已验收工作记录。它不是生产插件，也不是通用员工执行器。2026-10-15 实际运行已结束，锁文件和账本会阻止重复付费调用。

复用 [SkillX](https://github.com/zjunlp/SkillX) 的 `IterativeSkillPipeline`、功能技能提炼及原生两级过滤，固定提交 `b0047c848dbbcf019363d6d56eef8c558f69aefc`，MIT。上游源码保持原样；我们只做输入投影、模型账本适配和结果审计。

## 组成

- `prepare.py`：只读提取真实文件/知识调用、QA 回执和经理结论，保留事件序号。
- `run.py`：上游单轮提炼；沿用现成计划，关闭聚类、扩展及自动重试。`inspect` 禁止模型调用；`live` 只允许运行一次。
- `adapter.py`：实现上游 LLM 接口，最多三个阶段，解析或传输失败后停止。
- `bridge.mjs` / `guard.mjs`：可信 Node 进程沿用为伍 `completeBudgeted`，固定模型、输入/输出限制、金额及收据；Python 不获得 API Key。
- `preflight.mjs`：调用前后核对源数据和账本；`authorize` 仅封存本次已有授权。
- `audit.py`：离线核对真实收据、数据保持及候选引用字段，仅解析候选代码，不执行。

## 隔离环境与复现

本轮 JJ 使用 Python 3.14.4，venv 位于 `/home/jj/.local/share/weiwu/validation/skillx-pilot-20261015/venv`，约 175 MB。必要依赖是 `numpy`、`tqdm`、`langchain-openai` 及传递依赖；精确版本记录在验收证据的 `requirements-lock.txt`。没有安装 torch、transformers 或下载模型权重。源码清单与 SHA256 已保存；归档 SHA256 为 `590b7a13811f16ca2d26963923e684167d8a4392fa771ff7e9be69a5067fe623`。

宿主缺少 ensurepip，使用固定哈希的官方 PyPA `pip.pyz` 给隔离 venv 安装依赖，没有 sudo 或全局安装。上游只保留 Python 源码、LICENSE 和 README，排除了示例数据与 pycache。

本地回归（不调用模型）：

```text
node --test tests/skillx-pilot/guard.test.mjs
python -m unittest discover -s tests/skillx-pilot -p "test_*.py"
python scripts/validation/skillx-pilot/audit.py .data/skillx-pilot-20261015
```

原始样本和完整前后快照在 JJ 隔离目录，未提交公司资料全文。提交的证据包含原始候选、两次响应、收据摘要、源码清单及依赖锁。再次进行真实试验须先另列有明确样本和预算的计划；不要删除锁文件或账本记录来重放本轮。

完整结论见 `docs/validation/skillx-isolated-pilot-2026-10-15.md`。本轮候选被原生质量过滤拒绝，未进入知识库或员工工具目录。

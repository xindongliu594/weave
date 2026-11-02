# Core v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 以32例声明七维核心覆盖，执行可用的产品函数检查并拒绝缺证据的质量通过声明。

**Architecture:** 保留 v1，新增 Promptfoo custom provider/JS assertion 与薄报告门禁。合成输入驱动真实产品函数，等待真实运行的案例始终 pending。

**Tech Stack:** Node 24.15.0、Promptfoo 0.124.1、已有 tsx、Node test。

**Spec:** `docs/superpowers/specs/2026-10-25-agent-evaluation-design.md`；`docs/research/2026-10-29-core-evaluation.md`。

## Global Constraints

- 不调用付费模型、不读取生产资料或凭据、不部署；不改产品执行链路、package 或 CI。
- 不执行 Git 分支、提交、推送、stash/reset。
- 旧 v1 文件保持不变；独占新增 core-v2 文件和 evaluation-core 测试。
- fixture、产品函数、历史运行、fresh 模型证据分开；23+9为预期分层，不是预先写好的成绩。

## Review Focus

- 缺案例、重复案例、hash不符或未知状态必须失败。
- pending不可因Promptfoo全绿、NaN或改标签而变成成功。
- 合成输入不可称为模型输出，产品检查不可称为fresh真实业务。
- 新oracle须检查实际返回，不能把预期值直接返回充当结果。
- 并行源码变化必须标出；最终稳定版本由root重跑。

### Task 1: 数据与产品函数适配

**Files:** Create `tools/evaluations/datasets/core-v2.json`, `core-v2-checks.mjs`, `core-v2-provider.mjs`, `core-v2-assertion.mjs`; Test `tests/evaluation-core.test.mjs`。

- [x] RED：32个唯一案例，七维数量，pending非pass，execute拒绝，oracle与实际不符失败。
- [x] GREEN：provider `callApi`调用固定allowlist产品函数，输出实际值、证据与provenance；assertion对照独立dataset oracle，禁止外部expected覆盖。
- [x] 验证 `node --import tsx --test tests/evaluation-core.test.mjs`。

### Task 2: 版本绑定与Promptfoo实跑

**Files:** Create `tools/evaluations/core-v2-run.mjs`, `core-v2-gate.mjs`；追加README。

- [x] RED：遗漏/重复、伪fresh、缺证据、篡改raw/hash、pending和requireLive拒绝。
- [x] GREEN：受控config、原offline-guard、干净环境、独占输出路径；manifest绑定dataset/criteria/source/lock/raw；工程完整性与完整验收分离。
- [x] 真正CLI执行32例，pending断言失败为预期非零，不能吞掉runner错误或无报告错误。
- [x] 定向v1回归，root最终在稳定源码上重跑，不重复全库build。

### Task 3: 验收记录

**Files:** Create `docs/validation/core-evaluation-2026-10-29.md`。

- [x] 保存RED/GREEN摘要、CLI实际数量与hash，列出pending与执行层边界。
- [x] 报告接口/组件/浏览器/真实模型均未被本次产品函数检查替代；不声称省Token。

验收细节见 `docs/validation/core-evaluation-2026-10-29.md`。定向v1回归13/14，源码漂移1项待root最终稳定状态重跑；不将该项勾选解释为全量通过。独立审查由root安排。

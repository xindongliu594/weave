# OpenRig 工作台入口本地验证

日期：2026-10-09。范围：网页可选入口与请求状态保护；未部署，未发起真实 OpenRig 写入或模型请求。

## 用户行为

- 未启用时不显示卡片或说明；启用后批量读取当前页项目的本地映射。
- 用户显式点击「同步为待办」才提交当前项目版本；历史项目不会自动同步。
- 同步前保存项目 ID、版本与请求编号；请求结果未知时，刷新页面后仍仅提供「核对待办」。
- 核对使用 GET。未找到工作项不解除原未知请求；明确确认成功，或本次 POST 的可信未派发回执，才能解除标记。
- 同一项目在多个卡片出现时共享状态。旧批量响应不覆盖操作后的状态；刚核对的队列状态不会被批量接口的空状态覆盖。
- 队列 `done` 显示为「队列状态：已结束」；实际执行与验收仍通过为伍运行记录查阅。

## 本地检查

- `node --import tsx --test tests/openrig-workbench-ui.test.ts tests/project-status-ui.test.ts tests/run-trace-view.test.ts`：18/18 通过，无跳过。其中新增 10 项覆盖默认关闭、显式发送、未知请求、双击、明确前置拒绝、错误身份、浏览器存储失败、批量边界和队列展示。
- `tsc --noEmit --pretty false`：通过。
- `vite build`：通过。产物 `index-DRaaSSyr.js`、`index-CzCbk_YO.css`；仍有现有的单块大小提示。
- 回归中的 API 回执为测试输入，仅验证网页状态与调用约束，不作为真实业务验收证据。

## 冻结源文件

| 文件 | SHA-256 |
| --- | --- |
| `apps/web/src/OpenRigWorkbench.tsx` | `06cc6265d6f49da7926b5bd74b9a208e4d75a418eb9845f52851c6e235cc901e` |
| `apps/web/src/openrig-workbench.ts` | `a6bb2b000b27acce18083478ed2086d8db4586c649dd7dbd472388439ef360bf` |
| `apps/web/src/DepartmentWorkbench.tsx` | `1e72cd0327543ea2fd5e8ebf7cce36e86fbba3616677ce6751f69099afffb688` |
| `apps/web/src/DepartmentWorkbench.css` | `44b3129e375703d03ebab010d5e6653a3c479266729c495dcd35896721dffdcf` |
| `tests/openrig-workbench-ui.test.ts` | `a5c9f800c5ac509e9be4de788c56f27f17e8c6a1def2918edb1714ca77231fca` |

服务端契约与独立回归见 [OpenRig API 本地验证](openrig-api-local-2026-10-09.md)。部署后的浏览器操作与真实队列核对仍需另行记录。

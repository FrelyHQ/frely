# API Keys 重构基线

`/owner/keys` 遵守 `docs/baseline/frontend-state-management.md`，不改变 Admin API、权限、审计或 repository 契约。

## 数据所有权

| 数据/状态 | 唯一所有者 |
| --- | --- |
| API key rows、metrics、搜索结果 | RSC；不建立 list Query 或 props 副本 |
| 排序和 selection | TanStack Table；稳定 row id 为 API key `id` |
| revoke pending/error 生命周期 | TanStack Query mutation；`retry: false` |
| dialog open | 本地 UI state |
| 权限、审计和最终 revoke 规则 | Admin Route Handler/service |

批量 revoke 保持原有并行、非事务语义。成功后关闭 dialog、清空 selection 并执行一次 `router.refresh()`；失败时保留 dialog 与 selection，并显示安全 API 错误。

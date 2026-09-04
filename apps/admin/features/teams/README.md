# Admin Teams feature

## 数据所有权

| 数据 | 权威所有者 | 客户端职责 |
| --- | --- | --- |
| Team 列表、指标和详情 | RSC page / repository | 列表由 URL 驱动服务端搜索、排序并固定每页 20 条；Table 只选择当前页 rows，mutation 成功后单次 `router.refresh()` |
| Team 创建、设置、成员、角色、权限和 Plan 写入 | 现有 Admin Route Handler | Query mutation 统一 pending/error，`retry: false`；不在 Query cache 复制 RSC 数据 |
| Table 排序与选择 | URL / Repository + TanStack Table | 初始按 `createdAt` 升序、`id` 稳定兜底；排序、搜索或翻页后 selection 只保留当前页 |
| 表单输入 | TanStack Form | 仅本地可判定的轻量校验；权限和领域规则由 API 权威校验 |
| dialog、搜索和成功提示 | 组件 UI state | 不代表服务端数据，不进入 Query cache |

`app/owner/teams` 只负责路由、RSC 查询、权限/视图装配，并只从本 feature 的 `index.ts` 导入交互组件。mutation API 路径、请求载荷、权限、审计、非事务批量更新和刷新行为保持兼容。

Team directory 不展示或加载 Plan、Plan Usage、Budget Status；这些信息只在 Team 详情和独立 Plan/预算页面读取。RSC 与 `GET /api/owner/teams` 复用同一分页投影，响应包含 `page`、`pageSize`、`total` 和 `totalPages`。

成员角色和权限矩阵也直接消费 RSC rows；mutation 成功后只刷新 RSC，不在组件 state 手工维护第二份服务端列表。

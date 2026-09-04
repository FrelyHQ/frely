# Users 重构基线

`/owner/users` 遵守 `docs/baseline/frontend-state-management.md`。本 feature 的迁移不改变 Admin API、权限、审计或 repository 契约。

## 行为基线

- RSC 通过 `adminPageServices()` 鉴权，并由 `buildAdminUsersAggregate()` 读取首屏 metrics、搜索结果和 `q`；URL 搜索及页面文案保持不变。
- 表格展示 User、Team、Role、Role Bindings、Status、Admin Note、API Keys、Last Seen 和 Created At，详情与 Team 链接保持原路径。
- 初始按 User 升序；所有列可排序，稳定 row id 为 User `id`。排序和当前页 selection 由 TanStack Table 持有，rows 仍由 RSC 唯一持有。
- 批量操作仅支持通过 `PATCH /api/owner/users/:id` 设置或清除 admin note。请求保持并行、非事务语义：失败时可能已有部分用户更新成功。
- User 详情页的营销赠卡表单通过 `POST /api/owner/marketing-cards` 发放单张 Plan/Credit Card；Admin 赠卡有效期默认 30 天，`datetime-local` 按浏览器时区解释，Tooltip 展示 IANA 时区、UTC offset 和最终 UTC，服务端继续权威验证绝对时间、商品、接收者、转手和审计。
- mutation 成功后关闭 dialog、清空 selection 并调用一次 `router.refresh()`；失败时 dialog、输入和 selection 保留，并显示安全 API 错误。pending 时禁止重复提交和关闭。

## 数据所有权

| 数据/状态 | 唯一所有者 |
| --- | --- |
| Users rows、metrics、搜索结果 | RSC；不建立 list Query 或 props 副本 |
| 排序和 selection | TanStack Table；rows 消失后清理无效 selection |
| operation、admin note、字段错误和 submitting | TanStack Form |
| PATCH pending/error 生命周期 | TanStack Query mutation；`retry: false` |
| dialog open | 本地 UI state |
| 权限、输入边界、审计和最终业务校验 | Admin Route Handler/service |

## 完成验收

- `app/owner/users/page.tsx` 只负责 route、RSC 读取和页面装配，客户端业务只从 `features/users/index.ts` 导入。
- User 详情页的 Admin Note 表单和 Role Bindings 展示也归属本 feature；Note 使用 TanStack Form/Query 调用既有用户 PATCH API，写 mutation 不重试。
- `TanStackDataTable` 使用稳定列 id、User id、多选、批量操作和初始排序；旧 `DataTable`、手写排序、Set selection 和 fetch lifecycle 已删除。
- Form 只做 note 必填的轻量浏览器校验；服务端仍是权威校验边界。
- DTO 转换/API 调用与 React 状态分离并有纯函数测试；Admin typecheck 和相关测试通过。

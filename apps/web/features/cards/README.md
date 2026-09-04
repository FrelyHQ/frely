# Cards feature

Card inventory、单个 Plan 的 Card 明细和 transfer history 分别由独立 TanStack Query 持有，并以 inventory page、`planId + detail page`、transfer page 组成稳定 query key。三个集合都在 Credit Query Module 的数据库边界按 50 条分页；Plan Card 在 inventory 分页前按精确 `plan_id` 聚合，不能在客户端对 Card page 分组。

use/send 是 `retry: false` mutation，不对 Card、Subscription、Credit 或 append-only transfer 做乐观更新。成功后分别失效受影响的 inventory、Plan detail 和 transfer cache。send 的 recipient/reference/note 草稿由 TanStack Form 持有；dialog step/open 和 Plan detail page 是纯 UI state。

服务端继续权威执行当前 owner、enabled recipient、未使用、未过期、Plan action capability、一次性 compare-and-set、append-only transfer/audit，以及 Plan/Credit 履约事务。普通用户的发送表单不创建 Reference control 且 DTO 省略 `referenceCode`；Team Owner 的展示 capability 只用于 UI，Repository 仍在发送事务中按当前 enabled Team ownership 最终校验。note/reference 不进入 query key，note 不进入 audit metadata；列表只以服务端裁剪后的当前用户可见 transfer 为准。

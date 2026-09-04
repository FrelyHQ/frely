---
id: FEATURE-WEB-TEAM-INVITES
status: implemented
mdq:
  version: 1
  dialect: gfm
  records:
    boundary:
      source: heading
      levels: [1]
    key:
      source: heading
      pattern: '^(?P<id>FEATURE-WEB-TEAM-INVITES)$'
      group: id
  fields:
    raw:
      source: body
  tolerance:
    incomplete: false
---

# FEATURE-WEB-TEAM-INVITES

Web 只负责 Team API transport、包含 Team/User/page 的 TanStack Query key、失效和当前页状态。邀请设置、50 条一页的 links 与显式 capabilities 由单一 Query 持有；共享 UI、可见 action IDs、domain pattern 草稿、confirm、clipboard feedback、pending/error 和刚生成的 bearer link 由 `@frely/team-console-ui` 持有。

共享组件通过 action ports 发起 member toggle、domain rule、create link 和 disable link；Web adapter 只连接 `/api/team/*`。成功后只失效当前 Team/User 查询前缀。query key、日志和错误信息不得包含 invite token。

权限、owner/member 可见性、精确邮箱域名校验、递归邀请开关、link 唯一性和禁用规则继续由 Web Route Handler/tenancy 权威执行。links 使用 Repository Query Module 返回的真实 `page`、`pageSize`、`total` 和 `totalPages`，共享 UI 仅提供上一页/下一页，不引入客户端排序、筛选或 selection。

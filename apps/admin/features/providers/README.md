# Providers 前端基线

本文记录 `/owner/providers` 当前用户可见行为。服务端权限、credential、SSRF、审计和 reconciliation 仍由 Admin API 与内部控制面裁决。

## Provider 类型与创建

- Add Provider 只创建 CPA Provider，`kind` 显示 CPA 支持的真实 upstream 类型：Codex、Gemini、Claude、Antigravity、Kimi、xAI、OpenAI-compatible、Vertex。
- 只展示当前 kind 支持的 Auth Method；不展示 Binding Mode、CPA API Format、Base URL Resolver、Models Resolver 或可编辑 Config JSON。
- 规范 catalog resolver 固定为 `cliproxyapi:catalog`。旧 `cliproxy:catalog` 不进入 UI、Query cache 或新请求。
- Provider ID 同时是不可变的 credential/model prefix；UI 不提供第二份 prefix 字段。
- 新 Provider 默认 disabled。credential ready 与 model sync 可在 disabled 状态完成，只有管理员显式 Enable 后 Gateway 才可发送流量。
- API Key 流程的 Models 编辑器允许从 Friday 版本化固定目录搜索、逐个或批量选择模型，也允许补充目录外模型；每条映射独立编辑 upstream name 和 Provider 内唯一的 Friday alias，提交时发送完整 `models` 数组，不再把 Provider 压缩为单个 `Friday Model Alias`。
- credential 尚未保存时不直接请求需要认证的 upstream `/v1/models`；创建阶段使用固定目录或管理员补充，credential ready 后仍通过正式 `sync-models` 获取当前 Provider prefix 的真实目录。

## Connect 状态

- API Key：输入只在当前组件 state 中短暂存在，经 write-only mutation 交给 CPA；成功后立即清空，只显示脱敏 preview、revision 和 binding status。
- OAuth：打开 authorization page；需要 localhost callback 时允许粘贴最终 URL；服务端接受上游附加 query 参数但转发前只保留 `provider/state/code/error`，浏览器只轮询 Friday session，不直接访问 CPA。
- OAuth session pending 使用单请求轮询；临时浏览器/Control 访问失败按 2s 起步分级退避且最大 16s，服务端已缓存的 terminal error 立即停止并只显示安全阶段与稳定 code。新 session 隔离旧请求，Dialog 关闭或组件卸载立即取消 timer 和当前 fetch；callback URL/code/state 不进入 Query key、cache 或页面摘要。
- 创建 Provider 成功但 credential/catalog 未完成时保留 disabled draft，并显示可恢复的部分成功状态。

## 管理

- CPA Provider 的 Manage Dialog 只显示 kind、Auth Method、credential preview、binding status/revision/error、traffic status，以及 Replace/Clear/Retry Binding/Sync/Enable/Disable 操作。Retry 只在 binding 为 `pending | error` 时出现，成功仅刷新 binding 摘要，不自动同步模型或启用 Provider。
- Provider directory GET 只返回 PostgreSQL snapshot。表格渲染后对当前页超过 60 秒且已有 credential preview 的 binding 发送一次批量 reconcile POST；服务端并发上限为 3，按 Provider CPA identity 调用 Control，并以 binding revision CAS 写回。transient/unknown 不覆盖原状态。
- Provider 的 Manage Dialog 没有第二套连接模式或 Friday-owned credential 分支。
- disabled 且仍有关联在线 Provider cost facts 的 Provider 标记为 retained，默认由 RSC 隐藏；`showRetained=1` 显式显示 retained rows 和隐藏数量。enabled Provider 永不因历史事实隐藏。
- 删除在 UI 和 API 共用 billing history、AccessPoint、disabled 与 CPA credential-cleared blocker；API 在任何 Provider/CPA 副作用前返回稳定 409，不泄露底层数据库约束错误。
- eligible 删除先写入并回读验证 credential-free retirement archive，再删除在线 Provider/ProviderModel/binding；恢复后必须重新授权，不能从 archive 恢复 credential。

## API 契约

| 操作 | Method / endpoint |
| --- | --- |
| 创建/编辑/删除 | `POST/PATCH/DELETE /api/owner/providers` |
| OAuth | `POST /api/owner/providers/:id/oauth/start`、`.../callback`；`GET .../status` |
| 保存/替换 credential | `POST /api/owner/providers/:id/credential` |
| 清除 credential | `DELETE /api/owner/providers/:id/credential` |
| reconcile | `POST /api/owner/providers/:id/reconcile` |
| 刷新当前页 stale binding | `POST /api/owner/providers/reconcile-status` |
| 同步模型 | `POST /api/owner/providers/:id/sync-models` |

Admin 不提供通用 CPA Management API 代理，不返回 token、auth file、账号列表、内部 URL 或 secret。

## 安全验收

- RSC props、Query key/cache、表格、表单默认值、错误、快照和 request capture 不得出现原始 API key、OAuth code/state/token、Authorization、identity 或 encrypted blob。
- 浏览器只做 required、kind/auth-method 和基本输入校验；权限、SSRF、prefix、callback、credential read-after-write 与最终 binding 状态由服务端裁决。
- Model sync 只刷新当前 Provider prefix 的 catalog，不自动创建成本、AccessPoint、售价、Plan entitlement 或 Subscription。

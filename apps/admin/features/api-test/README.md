# Admin API Test feature

关联需求：`REQ-GA-003`、`REQ-MEMBER-004`。

API key/AccessPoint 选项由 TanStack Query 持有；Gateway URL、API Type、选择项、手工 API key 和 Chat/Responses/Messages 三份 payload 草稿由 TanStack Form 持有；执行 pending/error/result 由 `retry: false`、`gcTime: 0` 的 mutation 持有。切换 API Type 保留各自草稿并 reset 上一次 result；AccessPoint exposed model 同步到所有可解析草稿，服务端仍覆盖为权威 model。

Admin API Test 只执行非流式请求。`stream: true` 必须稳定拒绝，不能在未消费 Provider stream 时返回成功；需要直接验证流式 endpoint 时使用页面生成的 curl 命令。

页面内执行使用 saved key 的私有 `key_value` 或本次请求携带的 Manual API Key，通过环境固定的内部 Gateway origin 调用正式 `/v1/chat/completions`、`/v1/responses` 或 `/v1/messages`。Admin Route Handler 不构造本地 Provider adapter、不持有 CLIProxyAPI inference secret，也不绕过所选 API key 的 AccessPoint 可见性、Plan entitlement、预算、限流、usage 或 billing。selected AccessPoint 只负责把权威 `exposed_model` 写入 payload；最终解析由 Gateway 决定。

每条 API key 都必须持久化非空 `key_value`，普通脱敏摘要仍不返回 `key_value`、hash 或额外的原值可用性字段。Schema 85 会把历史 `key_value IS NULL` 记录写入不可执行的 tombstone，并同时标记为 `disabled`、写入 `revoked_at`，因此这些记录不会进入 API Test 的 enabled key 列表，也不能重新启用。Send 与 Copy curl 共用同一个 executable identity 判断：非空 Manual API Key，或已选择的 enabled Saved Key。没有可执行 identity 时两个动作都禁用。

Manual API Key 非空时是唯一 identity 来源，页面立即清空 Saved Key 选择，摘要只显示 `Manual API Key`，不显示或派生手工 key prefix；清空 Manual API Key 后不自动恢复原 Saved Key。

curl preview 始终使用 `<api-key>`。Manual API Key 只在浏览器内注入 clipboard；保存 key 由 `POST /api/owner/api-test/curl` 从既有 `key_value` 兼容字段生成 `private, no-store` 完整命令，客户端立即写入 clipboard 且 mutation 不保留 data。复制动作记录安全 audit 摘要，但 key、command、payload 和 prompt 不进入 metadata。缺少 `key_value` 的旧 key 明确提示使用 Manual API Key。

query key 只有静态 `admin/api-test/inputs`，不包含 API key、Authorization、prompt、payload 或响应。手工 key、完整 curl command 和原始请求/响应不进入 Query cache、日志或持久化；服务端 Route Handler 继续承担 Admin 鉴权、payload 校验和 safe audit，真实 API key 认证与请求执行边界由 Gateway 承担。表单 Gateway URL 只用于 curl command；页面内请求的内部 origin 不接受浏览器覆盖。

# Web API Test feature

available model options 由 RSC 按当前用户可见 AccessPoint 裁剪。model 与 JSON body 草稿由 TanStack Form 持有；请求 pending/error/result/raw response 由 `retry: false`、`gcTime: 0` mutation 持有。每次执行使用独立 AbortController，用户可取消；取消不会自动重试。

Web Route Handler 选择当前用户持有原始 `key_value` 的 enabled API key，通过环境固定的内部 Gateway origin 调用正式 `/v1/chat/completions`。Web 不构造本地 Provider adapter、不持有 CLIProxyAPI inference secret；API key 认证、AccessPoint 解析、Plan/预算/限流、Request Log、Capture、usage 和 billing 均由 Gateway 执行。只有不可恢复历史 key 的用户需要创建新 key 后再测试。

不存在包含 API key、Authorization、prompt/body 或响应的 query key。raw response 只在当前 mutation observer 生命周期展示，不持久化。Web session、API key 选择、AccessPoint resolution、usage/billing 和 request capture 仍由服务端现有边界处理。

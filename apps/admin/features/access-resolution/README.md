# Access Resolution Preview 重构基线

动态 API key/AccessPoint 选项由 TanStack Query 持有；表单草稿和轻量必填校验由 TanStack Form 持有；preview command 的 pending/error/result 由无重试的 TanStack Query mutation 持有。query key 只含静态 feature 标识，不含 API key id、model、credential 或请求 body。

Route Handler 继续负责 Admin 权限、Provider/AccessPoint 分层可见性、resolution 和响应裁剪。credential 内容不会进入表单、query key 或持久 cache；页面不启用 cache persistence。

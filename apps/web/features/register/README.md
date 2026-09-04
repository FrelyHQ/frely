# Register feature

Invite preview、Team 文案和当前身份继续由 RSC 持有。匿名注册的 email/password 草稿和轻量必填校验由 TanStack Form 持有；接受邀请的 pending/error/success 由 `retry: false`、`gcTime: 0` 的 mutation 持有。invite token、password 和请求 body 不进入 query key或持久 cache，服务端继续负责邀请有效性、域限制、防滥用、认证和 membership 权威校验。

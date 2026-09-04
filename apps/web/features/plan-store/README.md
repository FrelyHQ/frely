# Plan Store feature

Plan products 继续由 RSC 按当前 visibility chain 裁剪并唯一持有。购买是 `retry: false` mutation，不乐观更新 Credit balance、Card、Subscription、entitlement、ledger 或 settlement；成功后调用一次 `router.refresh()`。

打开确认 dialog 时为该购买意图生成 idempotency key，失败后重复确认继续复用同一个 key，关闭并重新发起才生成新 key。`useImmediately` 与 key 一起固定在该意图中。服务端继续权威执行余额、Plan version/status、Card 创建/使用和 append-only 账务事务。

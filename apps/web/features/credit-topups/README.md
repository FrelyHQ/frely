# Credit Top-ups feature

listings/topups 继续由 RSC 唯一持有。listing、transaction reference 和 evidence file 草稿由 TanStack Form 持有；create/reference/upload 顺序链和 cancel 由统一 `retry: false` mutation 持有，成功后只调用一次 `router.refresh()`，不乐观更新余额、Topup、Card 或 ledger。

每个线下 `购买并使用` / `购买` 意图在失败重试期间复用稳定 idempotency key。每个 Stripe Card listing 也独立持有稳定 key；点击 **Buy with Stripe** 后直接创建 Checkout 并跳转，固定 `useImmediately=false`，不经过确认 Dialog。价格、审核、append-only ledger、Card 履约和权限继续由服务端权威执行。

Manual-review listings retain the evidence and Owner-approval flow. A `stripe_checkout` listing must use the `stripe` network and USD cents; the client calls `/api/user/stripe/checkout`, then redirects to a Stripe-hosted Checkout Session.

Before enabling the channel, activate the Stripe merchant account with its legal entity and representative details, payout bank account, customer-facing statement descriptor, and two-factor authentication. These operational steps follow the supplied mainland-China registration reference; actual eligibility and verification requirements remain controlled by Stripe.

Set the following server-only environment variables on the `web` service. Do not put secret values in browser-visible configuration, logs, audit metadata, or source control:

- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_PAYMENT_METHOD_CONFIGURATION` (required in production; enable only validated synchronous methods)

Configure Stripe to deliver `checkout.session.completed` and `checkout.session.async_payment_succeeded` to `https://<public-web-host>/api/stripe/webhook`. The webhook caps the body at 128 KiB, uses the official Stripe SDK to verify the raw request body and `Stripe-Signature`, and rejects live/test mode mixing. Only `payment_status=paid` events whose topup metadata, currency, and amount match the pending topup can create Card or ledger facts. Event status, fulfillment, and completion audit are idempotent; repeated deliveries do not create another Card or ledger event.

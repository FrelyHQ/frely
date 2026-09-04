# User Chat

The User Console chat surface is intentionally small: one in-memory assistant-ui
thread, one selected user-visible `AccessPoint` model, text messages, and one
JPEG/PNG/WebP image attachment per user message.

The feature uses `@assistant-ui/react` only for its headless runtime and
primitives. It does not use Assistant Cloud, an AI SDK, tools, streaming,
thread history, local storage, or a second hosted chat runtime. The adapter
calls the existing `/api/user/chat` route, which keeps the Web session and API
key boundary on the server before invoking the formal Gateway path.

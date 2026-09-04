# System Settings 重构基线

`/owner/system-settings` 保持 RSC 鉴权和首屏读取。Request Capture toggle 使用既有 `PATCH /api/owner/request-capture`，不改变 capture 存储、权限、审计或敏感数据边界。

Ingress Plugins 区域从 Gateway 静态 registry 读取 ID、description、version 和声明式表单元数据，并与数据库 `global:` setting join。第一版仅允许 `PATCH /api/owner/ingress-plugins/:id` 原子保存 common enabled 与插件 config；非法 plugin、非 `global:` scope 和未通过插件严格 schema 的 config 均拒绝。浏览器不接受动态 renderer，当前只渲染 `multi-select`。

## 数据所有权

| 数据/状态 | 唯一所有者 |
| --- | --- |
| 首屏 Request Capture setting | RSC |
| 首屏 Ingress Plugin registry/global settings | RSC |
| mutation 返回后的 setting、pending/error/success | TanStack Query mutation；`retry: false` |
| 环境配置和其余只读 guardrails | RSC |
| 权限、持久化和 capture 安全规则 | Admin Route Handler/service |

toggle 不做预先乐观更新。成功后显示服务端返回值并调用一次 `router.refresh()`；失败时保持权威值并显示安全错误。

Ingress Plugin 保存审计 metadata 只包含 plugin ID、scope、version、前后 enabled 和发生变化的 config key，不包含 config 值或请求正文。

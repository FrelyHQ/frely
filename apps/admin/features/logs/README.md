# Admin Logs feature

`/owner/request-logs` 和 `/owner/audit-logs` 遵守 `docs/baseline/frontend-state-management.md`。

## 数据所有权

- URL 是筛选和分页的唯一权威状态；服务端对参数做 allowlist 和正规化。
- RSC 负责 Admin 身份/权限、repository 与 archive 查询，并把 public view model 交给本 feature。
- Request Logs 和 Audit Logs 使用 TanStack Table manual 模式；浏览器不下载全量数据做分页、筛选或排序。
- Request Capture 是唯一进入 Query cache 的日志数据。key 使用 `admin` namespace，`gcTime` 很短，不持久化，关闭 dialog 时取消请求并精确移除。
- Request Log 的 Error Detail 只展示稳定 error code 与耗时，不读取或展示 Provider diagnostic；Admin 可选择 `View raw capture` 查看 JSON view，或直接选择 `Download Capture` 下载原始单条 `.jsonl.zst`，下载不要求先打开 Raw Request。

## 安全与兼容边界

- Raw Request 与 Error Detail 的单条 Capture download 都使用普通链接，直接返回原始 `.jsonl.zst`；批量下载使用普通链接访问 `/api/owner/request-logs/captures/download`，按筛选结果把原始文件顺序写入 tar stream，不创建后台任务或浏览器 Blob。
- Capture payload 不进入 URL、table state、日志或 audit metadata。
- Admin 与 Web 使用不同 Query namespace，不共享敏感读取 cache key。

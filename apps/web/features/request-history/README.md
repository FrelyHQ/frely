# Request History feature

筛选、分页、归档查询和首屏 rows 继续由 URL + RSC/server storage 查询持有；当前表是服务端已分页的固定展示，不在浏览器重复排序、筛选或分页。按需 raw capture 由共享 TanStack Query dialog 读取，使用短 `gcTime`，关闭时取消并移除精确 cache；request/response 原文不持久化。

批量 Request Capture 下载使用普通链接访问 `/api/user/request-logs/captures/download`。服务端按当前筛选和用户权限派生 Capture v3 路径，把原始 `.jsonl.zst` 顺序写入 tar stream；浏览器不使用 `fetch().blob()`，也不创建或轮询后台任务。

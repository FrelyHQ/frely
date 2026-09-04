# Key Usage feature

API key 输入是单字段简单表单，保留局部 UI state；服务端 lookup 的 pending/error/result 由 `retry: false`、`gcTime: 0` 的 mutation 持有。key 只作为 Bearer header 发送，不进入 query key、URL、响应、日志或持久 cache。结果表是固定详情展示，不具备复杂表格能力，因此保留语义化 Table。

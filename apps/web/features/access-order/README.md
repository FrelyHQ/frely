# Access Order feature

首屏 order rows 由 RSC 唯一持有并作为拖拽草稿初值；拖拽顺序和 dragged id 是纯 UI state。PUT 的 pending/error/success 由 `retry: false` 的 mutation 持有。每次提交只发送当前 model 的稳定 plan-scope id 顺序；权限、model 分组、有效成员和最终顺序校验继续由 Web Route Handler/service 决定。

## 页面结构

- 页面使用“model 选择器 + 当前 model 全宽顺序编辑器”的主从结构。model 数量增长只增加选择项，不得把多个顺序编辑器自动压入同一行。
- 编辑器每次只展示一个 model；来源行固定分层展示 rank、Plan/scope、Subscription、AccessPoint 和 availability，长技术 ID 单行截断并通过 `title` 保留完整值。
- 桌面可拖拽到目标来源的前后半区；上移/下移按钮是键盘和触屏的等价路径。两种交互都只修改当前 model 的本地草稿。
- 当前顺序与最近成功保存的快照不同时显示 `Unsaved changes` 并启用保存。保存成功只更新该 model 的快照，不改变其他 model 的草稿。
- 860px 以下 model 选择器移到编辑器上方，680px 以下来源 metadata 和移动按钮改为单列/底部布局；任何断点都不得把来源字段压到逐字符换行。

API、排序主键和 Gateway 行为保持不变；UI 不新增 Provider、credential、完整 AccessPoint chain 或其他内部信息暴露。

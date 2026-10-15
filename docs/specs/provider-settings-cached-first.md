# Provider 设置视图缓存优先渲染（cached-first）

## 背景

设置页「供应商和模型」冷启动依赖 renderer → host 的 `getView()` RPC 往返。
健康路径耗时 <200ms；但存在偶发的 renderer 主线程长间歇（17–35s，已确认与
app JS、main 进程、host 无关），期间页面停留在「加载中」。

## 规则

1. Renderer 在每次接受新的 `ProviderSettingsView`（revision 提交成功）时，
   把该视图序列化持久化到 `localStorage`（key: `zcode.provider-settings-view-cache.v1`，
   含 `savedAt` 时间戳）。
2. `useProviderSettingsServiceView` 冷挂载（无 retained ready 状态）时：
   - 若存在可解析的缓存视图，立即以 `ready` + `fromCache` 种子渲染，
     用户马上看到上次的供应商数据，不再等待 RPC；
   - 缓存缺失或解析失败时，保持现状 `loading`。
3. 缓存种子的视图接受任何后续新视图：`fromCache` 状态下 revision 比较
   不生效（host 重启后 revision 可能回退到 1，按 revision 拒收会导致
   永久显示旧缓存），第一条到达的 RPC/事件视图无条件覆盖缓存。
4. 持久化失败（隐私模式、配额满）静默降级为无缓存，不影响主流程。
5. 缓存属于 renderer 表现层优化，不是事实来源：服务端 View 永远覆盖缓存。

## 验收场景

- 冷启动打开设置页：立即渲染上次数据（<50ms），RPC 返回后无缝刷新。
- 首次使用（无缓存）：行为与现状一致（loading → ready）。
- localStorage 被清空/损坏 JSON：静默回退 loading，不报错。
- 缓存显示的 revision 高于 host 新 revision：新视图仍被接受。

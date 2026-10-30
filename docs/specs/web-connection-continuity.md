# Spec: Web 逻辑连接连续性与在途结果有效性

## 背景

Web 稳定 facade（`packages/web/src/connection/switchableServiceAccessor.ts`）当前只用物理 `target` / `generation` 判定在途结果是否有效：`await` 返回后只要 target 或 generation 变化就抛出 `ConnectionClosed`。这会把两类语义不同的事件混在一起：

- **同一逻辑连接的传输切换**：WSS→RTC 升级时旧 WSS 仍存活，Host 侧两条通道挂到同一 `activeServices`，读取结果在语义上有效；
- **逻辑连接失效**：真实断线、重连到新 Host、Host 重启，旧结果不可信。

前一种情况下 facade 丢弃成功结果，消费者（文件侧栏、模型目录等）把 `ConnectionClosed` 当成读取失败并持久化，用户被迫手动刷新/重连。本 spec 在连接/facade 层引入逻辑连续性代际，把两类事件分开判定。

范围仅限连接与 facade 合同。`packages/ui` 的读取恢复合同见 [workspace-files.md](./workspace-files.md) 的「连接中断与恢复」；本 spec 不改变 UI 状态机。

## 术语

| 术语                   | 含义                                                             | Owner          |
| ---------------------- | ---------------------------------------------------------------- | -------------- |
| physical target        | 当前发布给页面的 `RemoteServiceAccess`，对应一条 WSS 或 RTC 通道 | 连接发布者     |
| `generation`           | 物理 target 发布代际；targetKey 变化时递增                       | 连接发布者     |
| `continuityGeneration` | 逻辑连接代际；同一 Host 逻辑附件内保持稳定                       | 连接发布者     |
| 稳定 facade            | 页面生命周期内身份稳定的 service 代理                            | `packages/web` |

`continuityGeneration` 的数值单调分配，且**不能跨连接实例复用**。同一 `connection` owner 内，它回答“这条在途结果是否仍属于当前逻辑连接”；物理 `generation` 继续回答“当前应该把新调用与事件路由到哪条通道”。

## 单一 owner 与分配规则

`continuityGeneration` 的唯一 owner 是发布 `WebSocketConnectionSnapshot` 的连接对象，没有第二个 token 来源：

- `ManagedWebSocketConnection`：模块级单调分配器在**每次新连接尝试**和**每次断线丢失**时分配新值。断线时即使 `generation` 尚未递增（失败发布会保留原 generation），也必须立即分配，确保 `services: null` 期间的迟到结果不会被接受。
- `OpportunityWebRtcConnection`：直接镜像当前 fallback 快照的 `continuityGeneration`。WSS→RTC、RTC→WSS 的 target 切换不分配；fallback 换代、断开、前台强制重建时由 fallback owner 分配新值，组合快照随之变化。
- 分配器位于 `packages/client/src/websocket.ts`，全进程单调；两个连接实例不会得到同一个值。这保证 `WebApp` 的 connection 替换边界不会误复用旧 token。

### 快照合同

`WebSocketConnectionSnapshot.continuityGeneration?: number`：

- 生产发布者（managed WSS 与 WebRTC 选择器）始终写入；
- 字段可选只为兼容测试/外部快照构造者；
- 缺失表示调用方没有 continuity 合同，facade 必须退回旧行为（见下）。

## Facade 合同

`SwitchableServiceAccessor.setTarget(target, generation, continuityGeneration?)`：

- `generation` 继续用于路由、订阅归属与旧事件守卫，语义不变。
- `continuityGeneration` 不传（legacy 调用方）：完整保留旧行为——target 或 generation 任一变化，在途成功结果都失效。**不得**用 `generation` 顶替 continuity。
- 传入时：在途调用结果有效的条件是**调用与 `await` 返回时 continuity 相同且 target 非空**。target 身份变化不单独构成失效。
- 调用时 target 上没有该方法：仍抛 not-sent `ConnectionClosed`（`markCommandNotSent`）。
- `applySwitch` 的订阅释放/迁移、`attachSubscription` 的旧代事件守卫保持不变。
- 端口 `SERVICE_ACCESSOR_CONNECTION` 语义不变：只在“新的非空物理 attachment 已就绪”时通知；断线不通知。消费者重建订阅的时机不减少。

### 失败语义

- 同 continuity 的物理切换（WSS→RTC）：在途成功结果正常返回；旧 target 上的写只执行一次，不重发到新 target。
- continuity 变化或 target 变为 `null`：迟到成功结果抛 `ConnectionClosed`，不带 not-sent 标记。
- 真实 transport 拒绝（socket 关闭、RTC 通道拆除）：继续按拒绝传播，不得转换成成功。
- 不自动重放任何已发出、结果未知的命令；写请求的幂等/重试仍由业务层决定。

## 事件顺序

```text
同一 Host（Host 侧 activeServices 唯一）
  WSS gen1 ─┐
            ├─ OpportunityWebRtcConnection
  RTC gen2 ─┘   snapshot{services, generation, continuityGeneration}
                       │
                       ▼
             WebApp useLayoutEffect → facade.setTarget(...)
                       │
        generation  → 路由 / 订阅 / 旧事件守卫
        continuity  → 在途结果有效性
```

WSS→RTC 升级：

```text
RTC ready → publishComposed: targetKey=rtc:id, generation+1, continuity 不变
→ facade.setTarget(rtc.services, gen+1, c)
→ 释放旧订阅、通知端口、绑定新订阅
→ 旧 WSS 上的在途 readdir 完成 → continuity 仍为 c → 正常返回
→ 之后的新调用只走 rtc.services
```

真实断线：

```text
socket close → facade target=null, generation=g, continuity=c'（立即换新）
→ 在途成功结果因 continuity 不匹配被拒
→ retry: 新 attempt，再次分配 continuity=c''，services=null
→ connected: setTarget(newServices, g+1, c'')
→ 旧代结果（c 或 c'）一律不能进入页面；不重放命令
```

## 不变量

1. 同一 continuity 内的物理 target 切换，不得使成功结果失效。
2. continuity 变化或 target 为 `null` 时，迟到成功结果不得交付。
3. `services: null` 一旦发布，即使用于恢复的 fallback generation 尚未递增，也必须先更换 continuity。
4. legacy 调用方（无 continuity）必须保留 target 或 generation 变化即失效的旧行为。
5. 数字 token 只在同一 connection owner 内有意义，跨实例/Host 不得复用。
6. 已发出的写命令只执行一次，不因切换或恢复被重放。
7. 真实 transport 拒绝不得被 facade 转换为成功。
8. 物理 attachment 每次变化仍触发端口通知；`desktop-continuous` 与 `web-remote-replayable` 的投递语义不变。

## 非目标

- 不改变文件树、模型目录等消费者的恢复策略；文件树恢复合同见 [workspace-files.md](./workspace-files.md) 的「连接中断与恢复」。
- 不引入自动重放、命令队列或第二份 accepted state。
- 不修改 Host、wire protocol、`packages/desktop` 或流式 gap 修复。
- 不承诺跨调用全局顺序；需要顺序的调用方保留自己的 request version。

## 验收场景

1. 同 continuity 下 WSS→RTC 升级，在途 `readdir` 成功结果正常返回，不产生 `ConnectionClosed`。
2. 升级后的新调用只在新 target 上执行一次；旧 target 不收到新调用。
3. RTC 通道中途关闭、fallback 存活：新调用回退 WSS；旧 RTC 在途拒绝保持为拒绝。
4. 真实断线：`services: null` 发布时 continuity 立即变化；旧代迟到成功被拒。
5. 重连成功后 continuity 与断线前、断线中均不同。
6. 无 continuity 的 legacy `setTarget`：同 generation 换 target 时旧在途结果仍失效。
7. 已发出写命令在切换/恢复过程中只执行一次。
8. 端口在每次物理 attachment 变化时各通知一次；断线不通知。

# Spec: 对话时间线前插块（测量与装载同一个 DOM）

## 目标

历史补页的**测量**与**装载**必须发生在**同一批 DOM 节点**上：前插页以真实 DOM 渲染进虚拟列表上方的 0 高容器（内容负偏移到屏幕外，已布局、可测量、不可见），装载是「去掉偏移」的样式翻转。渲染只发生一次，不存在「量完卸载、再重新挂载」的第二遍。

这是用户定的硬约束。前两代实现都违反了它：

```text
第一代：直接提交进虚拟列表，行按 estimateSize 渲染，渲染完被真实高度逐条修正，
        每次修正再补一次 scrollTop——同一个位移被算多遍，列表漂移。
第二代：隐藏测量层先量一遍，提交时卸载测量层，虚拟列表重新挂载——渲染两遍，
        测量 DOM 与装载 DOM 是两批节点，React 不复用。
本代：  staged 单元翻转成 committed，className 变化，节点不动。
```

## 现状与根因（第二代为什么被替换）

第二代把「高度必须先量出来」落在了组件消息层里一个独立测量层：`pendingOlderUnits` 渲染成 `absolute + invisible + h-0` 的隐藏块，量出高度写进 `heightCacheRef`，闸门过了才提交。提交那一帧 `pendingOlderRows` 置 null，测量层整体卸载，虚拟列表按新窗口重新挂载可见行。

高度确实预知了（`estimateSize` 命中缓存、无二次测量循环），但代价是**同一页内容渲染两遍**，且第二遍是新 DOM。用户判定这不可接受：测量和装载必须是同一个 DOM。

## 产品规则

1. **块容器常驻**在消息层内，位于补页占位块之后、`headerSlot` 之前，`position: relative`、无子级时高度 0，宽度类经 `timelineContentColumnClass` 与正文列同源。
2. **容器内是一个扁平列表**，元素为 turn（与虚拟列表同粒度），key 为 turnId（即 unit.key）。列表 = `[...stagedTurns, ...committedTurns]`，staged 在前（代表更早的内容）。
3. **staged 态**：wrapper `absolute top-[-10000px] left-0 w-full`。负偏移方向是刻意的——`height: 0` 的容器里向下溢出会进 scrollHeight、污染全部坐标；向上偏移在滚动区域之外，对 `scrollTop`/`scrollHeight` 零影响。
4. **committed 态**：wrapper 回到文档流（无 absolute、无偏移）。staged → committed 是**同一个列表位置的 className 翻转**，key 不变，React 复用节点。
5. **就绪判定是构造性的**：闸门 effect 与提交回调都跑在 effects / task 阶段，而 effects 只在 commit（staged 的 DOM 已挂）之后运行——「staged 已渲染」不需要独立状态来证明。**不设会倒退的就绪布尔**：切会话置回 false 后 `stagedPrependUnits` 命中 EMPTY 常量、就绪 effect 不再触发，闸门永关、pending 永存，`loadingOlder` 恒真挡死预取、到顶锁死不释放——整个会话无法上滚（曾因此出过 P0）。staged 节点不挂 ResizeObserver，高度数值不参与闸门；提交帧结算用的是容器终值，装载后若内容长高（图片加载等），由容器级 ResizeObserver 经 `prependBlocksHeight` 走独立 inset 补偿。
6. **全量进块，无 trailing**：补页返回的每一行都进块容器暗处合练量真高，不再按 turnHeader 切分留尾巴。页由 CLI 按**整轮**交付（见 `conversation-timeline-turn-window-fill.md`），缝合只在单轮被单帧体积上限切开时仍会发生：页首轮延续到窗口首行时，拼好后的整轮（含窗口里已有的同轮前半截）在块里合练成完整一轮再翻转——拼好后的高度只能量拼好后的整轮，两截相加不等于合练值（折叠、分组、展开态一合并就变）。窗口为空时同样全量进块。
   6b. **跨页整轮缝合登记**：登记的 turn id 按集合命中从头认领——登记过的 turn id 即使被缝合变样也照样认回来；失效 id（换代、rewind 后不再出现的 turn）只是命中不了，自然结束。认领不按「登记顺序连续匹配」，首轮变样不再让整批块失效。
   6c. **首绘窗口不留在块容器里**：订阅首帧与换窗（`loadWindowAround`）的窗口走「暗处测量 → 一次挂载」管线（同一 spec），暗处那一帧用独立容器逐轮量高写入测高缓存，挂载后由虚拟列表接管全部单元，不登记进 `committedTurnIds`。理由：块容器里的单元永不被虚拟化回收，一旦首屏就整窗登记，整个会话退化成常驻 DOM，turn 级虚拟化失效。代价是首绘前多一遍重渲染（暗处一遍、可见一遍），发生在首帧之前，用户不可见。挂载期间块容器强制为空——同一批轮同时出现在两个容器里会撞 key，也会让 `prependBlocksHeight` 把暗处高度误记成实心块。
7. **空页允许提交**（Δ=0），防死锁；staged 列表为空视为就绪。
8. **装载一笔写入**：`flushSync` 内完成「`commit()` 合入窗口 + staged 翻转（先 commit 再扩展 committed 集合——commit 失败时不得登记悬空 turn id）」。补偿由 prepend effect（无依赖数组，每次 commit 必跑）的块分支在同一 commit 的 layout 阶段完成：同步读容器终值高度，`scrollTop += 有符号 totalSize 差值 + inset 差值` 一笔写入。totalSize 差值是有符号的（可正可负：窗口首轮被块收编后虚拟列表反而变短），不再钳到非负；块长高的部分在 inset 差值里。
9. **inset 记账**：`topInsetPx = headerSlotHeight + PENDING_HISTORY_SLOT_PX + prependBlocksHeight`。占位项是**常量**（块常驻，见 `conversation-timeline-top-placeholder.md`），差值恒为 0，账本不为它结算。prependBlocksHeight 由容器 ResizeObserver 维护（0.5px 容差，同 headerSlot 模式）；提交时同步读终值优先于 observer 回报，账本先结算，observer 到达后空转。
10. committed 集合是**集合语义**：前缀推导按「renderUnits 从头起逐个 key ∈ 集合」截断，失效 id（`logEpoch` 换代、rewind 改写窗口后不再出现的 turn）天然自愈——它们只是让前缀提前结束，不产生错误显示。会话切换（`sessionKey` 变化）显式清空 committed 集合并重置 staged 状态。**换代 / rewind 不做显式清空**：清空会把已提交的行从块赶回虚拟列表，inset 结算（-块高）与虚拟 start 平移（+块高）互相抵消后 scrollTop 本不应再动，独立 inset effect 的那笔写入反而制造一次整屏跳变。块内容与 store 行是同一数据源的派生，不引入第二份行拷贝。
11. 块内节点带与虚拟行相同的 `data-v4-turn-unit`、`data-turn-id` 属性；staged wrapper 额外带 `data-staged-turn="true"`，供填充循环的折叠高度测量 effect 按标记逐个实测（与首绘 staging 的 `data-staged-turn-key` 同款模式）。测量只读布局（`getBoundingClientRect`），不挂 ResizeObserver、不参与就绪判定——它喂的是填充条件（turn-window-fill 规则 11），不是闸门的块级就绪（第 5 条，构造性成立）。
12. **填充期间 staged 累积多页**：填充条件未成立前，取回的每一页都追加进同一缓冲、同一块容器暗处合练（折叠态渲染，历史轮 DOM 只有标题行与最后一条正文），提交仍是一次单笔翻转。跨页的同一巨轮（拆轮场景）在 staged 列表里按 turnId 缝合成整轮量高——高度只能量整轮，两截相加不等于合练值。
13. **取数失败进入冷却**：`loadOlder` 失败后 2 秒内的再次触发直接跳过，成功即清零冷却。确定性失败（如某行数据过不了协议校验） otherwise 会形成「失败 → `loadingOlder` 回落 → 预取条件再次满足 → 立即重试」的自旋：每秒数十次 RPC、列表上下弹跳（曾因协议校验失败触发，2026-09-28）。冷却必须落在 store 守卫里——预取触发条件（离顶距离、`canLoadOlder`）不随失败变化，没有冷却这个环没有断点。占位块改为常驻后，这个环里已经没有几何写入，冷却只剩「不再空转 RPC」这一层收益，但它仍然是唯一的断点。

## 为什么 TanStack 侧不需要改

`scrollMargin` 模型自洽（virtual-core）：`item.start` 从 `paddingStart + scrollMargin` 起算，`getVirtualItemForOffset` / `scrollToIndex` / `getOffsetForIndex` 全部工作在含 inset 的内容坐标系。只要 `topInsetPx` 准确等于「虚拟列表上方全部实心高度」，块的高度变化对 TanStack 调用是透明的。

## 状态所有权

- `ConversationProjectionStore`：`pendingOlder`、合并、纪元/游标校验（不变）。
- `ConversationTimeline`：staged/committed 集合、块容器高度、inset 账本、锁、闸门。
- `timelinePrependBlocks.ts`（新）：`splitPendingPageIntoBlockTurns` 纯函数——补页 rows → `{ blockRows, trailingRows }`。
- `timelinePrependCommit.ts`：锁条件、顶部条件、排程、inset 差值（保留；每行高度闸门删除）。

## 事件顺序

```text
用户接近顶部（离顶两视口）
  → loadOlder 取数，loadingOlder=true（占位块常驻，几何零变化）
  → 行进 pendingOlder 缓冲
  → splitPendingPageIntoBlockTurns 切出完整 turn
  → staged 单元渲染进块容器（负偏移，不可见，已布局）
  → staged 单元随 render 挂载进块容器（commit 完成即存在，构造性就绪）
  → 用户抵达 scrollTop 0：占位块完整可见，锁落下
  → flushSync 单笔（先 commit 再扩展集合）：
      store.commitPendingOlder() 合入窗口
      committedTurnIds ∪= staged 的 turnId
      （同一次渲染：staged 翻转进流）
  → prepend effect 块分支（同一 commit 的 layout 阶段）：
      同步读容器 getBoundingClientRect().height（DOM 已更新）
      结算 appliedTopInsetRef 到「header + 常驻占位项 + 容器实际高」
      scrollTop += (totalSize 增量 ?? 0) + inset 差值（一笔）
  → 解锁（pending 清空）
  → loadingOlder 回落：占位块内文字在 400ms 门槛后淡出（几何仍为零变化）
```

## 负面边界

- **不做已挂载块的再虚拟化**。DOM 只增不减：一期接受（页按整轮交付、旧 turn 折叠态 DOM 轻）；「越顶越远的页收编回虚拟化」留给二期。
- **不做「量完卸载、再挂载」的隐藏测量层**（第二代）。首绘的暗处测量是本 spec 唯一认可的例外，且它连例外都算不上：那一帧里被量的节点与被挂载的节点本来就是同一批 DOM 的第一次渲染，挂载是它们进入虚拟列表的第二次渲染，而它发生在首帧之前。
- `loadAllOlder`（问题目录 hydration / 分享只读）不块化，保持整窗换快照 + 现有 total-size fallback 补偿。
- 不改协议 payload 形状、`store` 合并规范；`rowsRange` 的**切页单位**由行数改为整轮与单帧字节预算，见 `conversation-timeline-turn-window-fill.md`。
- `prependVirtualAnchorAdjustment` 在补页路径退役（Δ 来自容器实际高度）；其 total-size fallback 分支为 `loadAllOlder` 保留。
- 导航目录在用户阅读块内内容时 active 高亮退化为第一项（现有 `items[0]` 兜底语义，不新增机制）。

## 验收标准

1. 滚到顶部：锁死、占位块可见；就绪后一次翻转，衔接处无跳动。断点验证前插页 DOM 节点在提交前后引用不变。
2. 提交后向上滚：块与虚拟行衔接处无空白、无重叠。
3. 回合导航器点击块内旧 query：正确跳转。
4. 查找定位到块内行：正确滚动。
5. rewind / 换代后：无幽灵块、无重复渲染。
6. 会话切换：块清空。
7. 窄屏块内换行高度与提交后一致（同一 DOM，构造成立；验证 staged 宽度类与真实列相同）。
8. 连续补页 3+ 次：composer 不被顶开，贴底不误触发。
9. `pnpm typecheck`、`pnpm lint`、`architecture:check --changed`、`packages/ui` 全量测试通过。

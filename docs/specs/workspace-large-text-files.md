# Spec: 大文本文件（完整编辑、分块按需编辑与提交冲突）

## 目标

文件工作台不再把 `> 8 MiB` 或含非法 UTF-8 的文本降级为整份只读视图：

- 不限制文件总大小；单次磁盘读取仍最多 256 KiB，渲染层内存不随文件总大小增长。
- `≤ 8 MiB` 且所有窗口 UTF-8 无损：有界分块完整读取后进入完整可编辑文本缓冲。
- `> 8 MiB`：进入固定 256 KiB 块的按需编辑模型，只加载当前块，不读取、不缓存、不拼接全文。
- 任一窗口存在非法 UTF-8：只把该块标为只读，以替换字符显示；其它块仍可编辑。保存时服务逐字节保留未触碰的坏字节，不重新编码整份文件。
- `8 MiB` 是「完整正文模型」与「固定块模型」的切换阈值，不是编辑能力上限。
- 普通文本与大文件都必须支持保存、另存为、全部保存、关闭脏标签与脏标记。

本规范细化 `workspace-files.md` 的文本打开、编辑、保存、冲突与文件服务边界；不复制其主视图、标签、菜单与平台布局规则。

## 实现边界

| 边界       | 决定                                                                                                                                                                                                                                 |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 总大小     | 不设上限。窗口读取硬上限 256 KiB；`> 8 MiB` 只加载当前块与必要的边界探查字节                                                                                                                                                         |
| 编辑模型   | `size ≤ 8 MiB` 且所有窗口 UTF-8 无损 → 完整正文缓冲；`size > 8 MiB` → 固定块模型；`≤ 8 MiB` 但任一窗口非法 → 丢弃完整正文，改走固定块模型，非法块只读                                                                                |
| 块参数     | `BLOCK_STEP = 256 KiB - 4 = 262140`；`blockIndex = floor(原文件字节偏移 / BLOCK_STEP)`；实际边界只向更大字节偏移对齐到 UTF-8 码点起始（+0…+3 字节）                                                                                  |
| 块不变式   | 块按原文件字节坐标连续、不重叠、无空洞；每块实际长度不超过 256 KiB；编辑块只替换自己的原始字节范围；相邻块以上一块确认后的实际结束位置衔接                                                                                           |
| 读取方法   | 打开决策与完整读取使用 `IFileService.readTextFileWindow`；块加载同样使用该 typed range read，带 `expectedVersion`，单次最多 256 KiB；边界不确定时先做 4 字节边界探查再按确认后的实际范围精确读取，探查与精确读取都钉住首窗 `version` |
| 编辑所有者 | Files Editor Store 是块修改、脏态、全 buffer 撤销 / 重做历史的唯一所有者；range store 只拥有当前磁盘原块                                                                                                                             |
| 保存       | 所有保存入口统一调用 `IFileService.commitTextFile`；普通文本用 `full`，大文件用基于原文件坐标的 `patches`；UI 不再调用旧 `writeTextFile`                                                                                             |
| 冲突       | 普通文本「覆盖」绑定弹窗观察到的版本；大文件不提供把补丁强套到新版本的覆盖，只允许取消保留或放弃并重载                                                                                                                               |
| 外部变化   | 激活时 watch + 重新激活探测；干净普通文本安全自动重载；脏文本只提示、绝不覆盖草稿；干净大文件提示后按需刷新；脏大文件不自动重基线；删除不自动重建                                                                                    |
| 持久化     | 普通文本草稿仍在 localStorage；大文件只持久化标签元数据到 localStorage，块补丁草稿异步写入 IndexedDB；恢复仅在基准版本一致时套用                                                                                                     |
| 平台       | Desktop 的 MessagePort 与 Web / 手机远控的 WebSocket / WebRTC 使用同一 `IFileService` typed RPC；不新增 Host、通道或文件流                                                                                                           |

## 产品规则

### 读取决策

每个文本候选文件在打开、恢复或冲突重载时，先通过一次 `readTextFileWindow({ offset: 0, length: 256 KiB })` 获得 `totalBytes`、`version`、`isBinary`、`hasDecodingErrors` 与首窗内容。决策只此一处：

```text
文本候选 → readTextFileWindow(offset=0, length≤256KiB)
  ├─ isBinary → 既有只读二进制 PreviewPane（不建立文本缓冲）
  ├─ totalBytes > 8 MiB → block-model：固定块编辑；首窗裁剪为 block 0
  └─ totalBytes ≤ 8 MiB
        ├─ 继续按窗口读到 EOF（带首窗 version），汇总 hasDecodingErrors
        ├─ 全部 false → full-text：完整正文可编辑
        └─ 任一 true → 丢弃已拼接正文，改走 block-model，非法块只读
```

- 已知非文本路径仍先走现有预览分类，不读文本。
- 未知扩展名必须先由 window read 的 `isBinary` 决定，不能仅凭路径或大小区分文本与二进制。
- 第一个窗口已读取的字节不得丢弃重读；完整模型从 `nextOffset` 继续，块模型直接把首窗裁剪为 block 0。
- `stat` 校验与版本检查在文件服务内部完成，调用方不自行拼版本或猜测文件大小。
- 文件服务对每次有界读取循环处理短读，直到填满请求长度或到达 EOF；0 字节读取结束本次读取。UTF-8 对齐、解码错误判定与窗口 `nextOffset` 必须基于实际收齐的字节，不能让一次短读造成合法码点被截断或误判。
- 首窗 `totalBytes` 是阈值判断的权威来源；完整读取的每个后续窗口必须带首窗 `version`。任一窗口版本不匹配、文件消失或读取失败，整次读取失败，不提交半份正文。

### `≤ 8 MiB` 且 UTF-8 无损：完整正文可编辑

- 从首窗开始，按 `nextOffset` 顺序读取到 EOF；每个请求最多 256 KiB。
- 所有窗口 `hasDecodingErrors` 都不为真时，才建立完整正文缓冲；`text` 与 `savedText` 都是完整正文，不设置 `truncated`。
- 任一块返回 `hasDecodingErrors: true` 时，已拼接内容不得写入 `text` / `savedText`，也不得进入完整正文草稿；转为固定块模型，由块级只读遮住坏块。
- 判定依据只能是服务对原始字节的 UTF-8 校验结果；合法编码的 U+FFFD（`EF BF BD`）不是解码错误。
- 读取期间磁盘跨过 8 MiB、版本变化或被 atomic rename 替换：整次完整读取失败，不得提交部分正文或混合版本内容。
- 结构上最多同时保留 8 MiB 完整正文与单窗 256 KiB；不以未实测的进程峰值内存作为承诺。

### `> 8 MiB` 或非法 UTF-8：固定块按需编辑

#### 规范化块

```text
BLOCK_STEP = 256 KiB - 4 = 262140
READ_WINDOW = 256 KiB

nominalStart(i) = i * BLOCK_STEP
nominalEnd(i)   = (i + 1) * BLOCK_STEP
actualStart(0)  = 0
actualStart(i)  = nominalStart(i) 落在合法多字节码点内部
                    ? 该码点之后的下一个起点   // 向更大偏移移动，最多 +3
                    : nominalStart(i)
actualEnd(i)    = 结束边界探查确认后的实际结束位置   // 末块为 totalBytes
block(i)        = [actualStart(i), actualEnd(i))    // actualEnd(i) == actualStart(i + 1)
blockIndex(off) = floor(off / BLOCK_STEP)
```

- `utf8BoundaryAtOrAfter` 只在 `nominalStart(i)` 位于一个合法 2–4 字节码点内部时向更大字节偏移对齐到该码点之后；合法码点起点与非法字节都保持请求偏移不动。不得为寻找“下一个合法起点”扫描任意长字节串，否则块长度会突破读取窗口。
- 因非法字节而使块起点落在非法序列内部时，该块按确定的原文件字节范围只读显示；服务不得为对齐而回退、丢弃或重新编码这些字节。
- 因为 `actualStart(i)` 单调且最多向更大字节偏移移动 3 字节，块之间连续、不重叠、无空洞；每块长度不超过 `BLOCK_STEP + 3 < READ_WINDOW`。任何编辑都不得改变其它块的原始坐标。
- 空文件、`totalBytes` 正好落在块边界、EOF 落在块中间都由上式覆盖；不额外做全文件边界表或全文件扫描。

#### 加载与裁剪

- 起点边界探查：加载目标块时先以 `offset = nominalStart(i)` 发一次最小窗口探查（最多 4 字节）。若返回 `offset < nominalStart(i)`，说明请求偏移落在合法多字节码点内部（服务只对合法码点回退，前置序列非法时保留请求 offset），此时 `actualStart(i) = 返回 offset + 首个码点字节长度`；否则 `actualStart(i) = nominalStart(i)`。相邻块加载时优先复用上一块确认后的实际结束位置，它就是下一块的 `actualStart`。
- 正式块读取：`readTextFileWindow({ path, offset: actualStart(i), length: 256 KiB, expectedVersion })`。`actualStart(i)` 是合法码点起点或已确定的非法字节边界，服务必须按该 offset 返回，不得再向更小偏移回退。
- **raw 窗口不保证覆盖下一个块边界。** 服务只在合法码点处回退：起点回退最多 3 字节，结束位置也只对合法码点回退。两者叠加后 raw 窗口可能止于 `nominalEnd(i)` 之前，也可能不含下一块起始字节；不得假定 raw 一定覆盖下一块起始、也不得因此省略边界确认。裁剪一律以确认后的实际边界为准。
- 结束边界探查：名义结束位置 `nominalEnd(i)` 可能落在合法多字节码点内部。对 `nominalEnd(i)` 发 4 字节探查：若返回 `offset < nominalEnd(i)`，说明请求偏移落在合法码点内部，`actualEnd(i) = 返回 offset + 首个码点字节长度`；否则 `actualEnd(i) = nominalEnd(i)`。末块直接到 `totalBytes`，不发探查。
- 精确复核：raw 窗口 `hasDecodingErrors` 为真，或 raw 窗口未覆盖 `nominalEnd(i)`（`window.offset + window.bytesRead < nominalEnd(i)` 且窗口被截短）时，先做结束边界探查得到 `actualEnd(i)`，再精确读取 `[actualStart(i), actualEnd(i))`，并把 `actualEnd(i)` 作为 `knownEnd` 交给裁剪纯函数；裁剪结果直接采用该结束位置，不再自行推算。
- 非法正文不得反推字节坐标：含替换字符的解码结果重新编码后长度会变化，不能用它推算原文件字节位置。字节坐标只能来自服务返回的 `offset` / `bytesRead` 与边界探查结果。
- 版本钉住：边界探查与精确读取都必须携带首窗 `version`（即使首次读取没有 `expectedVersion`）。探查或精确读取期间版本变化时不得混版，保留原窗口并提示刷新。
- `hasDecodingErrors` 必须对应本块精确字节范围。若 raw 窗口越界到下一块且报告的非法字节只存在于越界部分，精确复核后本块仍可编辑；真坏块只读，但其字节范围必须完整连续，不与相邻块产生空洞或重叠。
- 当前块是 range store 唯一加载的磁盘原块；切块时整体替换，不累积历史块，不建立全文缓存。最多保留当前块、每次最多 4 字节的边界探查结果与请求状态。
- 字节定位 / 百分比先用 `floor(target / BLOCK_STEP)` 选块。若 `target` 落在跨块的合法码点内部而小于 `actualStart(i)`，定位夹紧到 `actualStart(i)`；不为了精确命中该字节额外加载前一块。
- 首窗用于决策时已经读到的内容，可直接裁剪为 block 0 交给 range store，不重复读盘。

#### 编辑

- Files Editor Store 是编辑草稿的唯一所有者：

```ts
interface FilesLargeTextBlockChange {
  blockIndex: number;
  /** 原文件（expectedVersion）字节坐标中的块起点。 */
  offset: number;
  /** 本块在原文件中的字节数；EOF 追加时为 0。 */
  deleteBytes: number;
  /** 本块原始文本，用于脏态、撤销与丢弃。 */
  originalText: string;
  /** 当前块文本；空串表示删除整块内容。 */
  text: string;
}
```

- Store 用 `changes: FilesLargeTextBlockChange[]` 保存修改，同一块最多一条，按 `offset` 唯一；块内任意编辑都归入该块，相邻块可分别增删。EOF 追加是独立的零长度项 `{ offset: totalBytes, deleteBytes: 0, text }`，`blockIndex = floor(totalBytes / BLOCK_STEP)`；空文件时与首个零长度块合并。
- 只加载当前块的可编辑视图，不支持跨多个块的一次性范围选择 / 删除；需要跨块时先分别编辑相邻块。不得为了支持跨块编辑而加载全文。
- 非法 UTF-8 块以 U+FFFD 显示且只读；该块不能产生修改记录，也不能被补丁覆盖。切换到合法块后仍可正常编辑。搜索、行号与定位只覆盖当前块，不提供全文件搜索、全文件行号或错误索引。
- 脏态 = `changes` 中任一 `text !== originalText`。`> 8 MiB` 不建立 `savedText` 全文，也不把块文本写入普通文本草稿。
- 撤销 / 重做属于整个 buffer，而不是单个 split 或当前块：按用户编辑顺序保存块变更历史，每个历史项只记录受影响块的变更，不复制全文。切换块、切换 split、隐藏保活后重新激活都保留修改与历史。
- 保存成功或用户放弃修改后清空修改与历史，并以新文件版本重建块边界。

### 保存、冲突与完整性

- **所有保存入口同一条路径。** 保存、另存为、全部保存、关闭脏标签、标签脏标记与文件菜单最终都调用 `IFileService.commitTextFile`；只读二进制、加载中预览与非法块不能进入补丁。
- **普通文本使用 `full`。** `expectedVersion` 取运行时 `diskVersion`（打开、自动重载或上次成功保存得到的版本）；新建或未命名文件用 `expectedVersion: null` + `full`。
- **大文件使用 `patches`。** 只收集 `text !== originalText` 的有效变更，按原文件 `offset` 升序发送；`deleteBytes` 是本块原字节数，EOF 追加为 0。补丁范围不得重叠，允许首尾相接；同一偏移的多个零长度补丁拒绝。没有有效变更时不调用提交，只清除脏态。大文件没有完整正文，不能使用 `full`。
- **大文件提交期间暂时只读。** Files Editor Store 以 buffer 作用域保存唯一的提交 token；从目标版本探测前到提交结果应用并使旧窗口失效，禁止块输入、撤销、重做、放弃和异步草稿恢复。各 split 同步只读；重复保存不进入第二次提交。成功与失败都在 finally 中按 token 释放，不用时延推断同步完成。窗口按新版本重载与写盘结果解耦：读取失败只影响展示，不延长提交锁，也不把保存判为失败。普通文本仍允许提交期间继续输入，新输入保持未保存态。
- **成功提交后：** 用结果的 `version` / `totalBytes` 更新基准，清空修改、历史与 IndexedDB 补丁草稿；使 range store 当前块失效，再从新版本按需加载当前块。后续块坐标基于新文件重新计算，不把旧块按字节差平移到新固定块。
- **保存后的展示重载按新版本规范块起点：** 重载按保存前的块索引重新计算 `nominalStart(blockIndex)`，不得复用旧窗口的 `actualStart`；前块增删导致长度变化时，由统一块 loader 重新做边界探查与精确复核。读取失败只影响展示，不回滚已提交的 `version` / `totalBytes`，也不把保存结果当成写盘失败；旧窗口立即失效并发布绑定新版本的可重试错误态，重试 / 刷新不得再带旧 `baseVersion`，且重试仍回到保存前正在查看的块，不因错误态没有块快照而退回第 0 块。保存期间更早发出的窗口读取若迟到，必须因请求序号失效而丢弃，不得覆盖新版本窗口。
- **另存为改变路径后窗口 owner 立即切换：** 旧 owner 的窗口、块坐标与在途请求全部失效，旧 lease 不得继续展示或编辑旧窗口；新 owner / lease 按新路径与新版本重新加载。
- **重载和关闭不得丢弃新输入。** 显式放弃重载先读取磁盘，读取成功且缓冲身份、正文或块编辑代次仍与发起时一致，才替换草稿；读取失败或等待期间有新输入时保留原稿。保存后关闭必须重新检查脏态，新输入存在则再次提示，不直接关闭。
- **普通文本冲突：** 保存前读取或提交返回版本不一致即冲突。弹窗观察到的版本必须绑定到「用编辑器覆盖」：用户确认时以该版本作为 `expectedVersion` 提交完整正文；若磁盘在弹窗后再次变化，提交必须再次返回 `FILE_TEXT_COMMIT_CONFLICT` 并重新弹冲突，不能静默套用上一次确认。选择「使用磁盘」丢弃草稿并按同一读取决策重载。
- **大文件冲突：** 不提供「把补丁强套到新版本」的覆盖。源版本冲突时只能取消并保留草稿，或放弃草稿并按磁盘重载。磁盘版本、总大小或块边界变化后，旧补丁一律不得套用。另存为仅目标已存在、源基准未变时，可经用户确认绑定探测到的目标版本覆盖目标，源草稿不因此丢弃。
- **解码错误不得写回。** 普通文本发现任一窗口非法 UTF-8 时转为块模型或冲突，不把 U+FFFD 写回磁盘；大文件补丁不得覆盖非法块。服务提交补丁时，未被补丁替换的源字节必须逐字节流式复制，不得解码后重新编码。
- **已保存文件路径消失不自动重建。** `expectedVersion` 为字符串时，源 / 目标不存在即 `FILE_TEXT_COMMIT_CONFLICT`。只有用户显式选择「重新创建」才对普通文本使用 `expectedVersion: null` + `full`；服务必须确认目标仍不存在且 parent 已存在。大文件没有完整正文，不提供重建，只能放弃重载或另存为（源版本仍须一致）。删除后不得由自动保存、全部保存或延迟请求复活原路径。
- **另存为源和目标都受版本保护。** 已有路径另存为传 `sourcePath`、`expectedVersion`（源）与 `expectedTargetVersion`（目标：`null` = 必须不存在，字符串 = 必须匹配；省略按 `null`）。普通文本写 `full`，大文件写基于源版本的 `patches`。源版本已变化或删除时另存为失败，不把旧草稿复制到新路径。目标已存在时必须先经用户确认，确认后同时绑定源与目标版本覆盖；未确认前不得静默覆盖。未命名标签没有源，按目标 `null` + `full` 创建。
- **`expectedVersion: null` 只允许 `full`。** 该模式要求目标不存在，服务用原子 create-if-not-exists 提交；目标被外部抢先创建时返回冲突，不能覆盖。
- **写前有应用内缓冲身份 guard。** 写盘前重新确认缓冲 id、路径、工作区身份、可保存状态、基准版本与请求身份未变；缓冲被替换、转预览、改名或工作区切换则放弃写盘。
- **部分内容永不写盘。** 不完整正文、加载中窗口、非法块、截断草稿与替换字符结果都不能进入 `full`；补丁只允许来自已加载且有效的块。

### 文件变化、watch 与刷新

- **激活时 watch，重新激活时探测。** 普通文本与大文件缓冲在可见 / 激活时启动唯一 watcher（同一 buffer 的多个 split 共享一个）；隐藏保活不额外监听。重新激活、切回文件主视图或窗口重新获得焦点时做一次有界探测（首窗读取或 stat + 版本比较），补上隐藏期间的变化。
- **干净普通文本安全自动重载。** 探测或 watch 发现版本变化时，按同一读取决策重新读取；只有完整读取成功且身份未变才替换正文、`savedText` 与 `diskVersion`。若磁盘已变大或出现非法 UTF-8，转为块模型；变为二进制则转只读预览。读取失败保留旧缓冲并提示，不写盘。
- **脏普通文本只提示。** 任何已修改文本（普通或大文件）在外部变化 / 删除时只设置 `externalChange: "modified" | "deleted"` 并显示提示，绝不自动替换、重置基准或关闭标签。用户保存时按冲突处理。
- **干净大文件提示后按需刷新。** 不自动重基线；用户在提示上刷新后，重新取得版本并按新总大小夹紧当前块。刷新失败保留旧块并提示。
- **脏大文件不自动重基线。** 外部变化只提示；旧补丁继续以原 `baseVersion` 判定，保存必冲突。不得把新磁盘内容当作旧补丁的基准。
- **删除不自动复活。** 文件被删除时标记 `externalChange: "deleted"`，保留标签与脏草稿；不自动创建空文件、不自动保存、不自动关闭。只有用户显式「重新创建」（仅普通文本）或另存为到新目标才可能写盘。
- 旧路径、旧工作区或旧请求序号的 watch / 探测结果不得写入新缓冲。探测结果还必须匹配发起时的窗口对象与可见代次；保存、重载、切块或隐藏后迟到的探测不得反向标记新窗口。多个 split 共享同一在途探测。目录事件先提示变化，再用有界探测区分新版本、删除与二进制；干净缓冲的显式刷新不绑定旧版本，脏缓冲仍绑定补丁基准。
- 远程工作区断开时显示错误与重试入口；重试仍使用同一远程文件服务，不回退本机，也不按路径猜测本地文件。
- Monaco 初始化失败时显示错误与重试入口；共享 loader 必须清除本次失败缓存，让重试真正重新加载。

### 恢复与持久化

- **大文件标签元数据仍只进 localStorage：** `id`、`preview`、`path`、`kind: "large-text"` 与工作区身份；不落窗口正文、块偏移、版本或总大小。冷启动只恢复元数据，不 stat、不读盘；首次激活时按需读取并重新做读取决策。
- **块补丁草稿只进 IndexedDB，异步持久化：** 记录 `{ bufferId, path, workspace, baseVersion, totalBytes, changes, updatedAt }`，按 `workspaceIdentity?.trim() || workspacePath` + 路径隔离。不写入 localStorage，不包含完整文件正文、当前窗口、未修改块或撤销历史。写入去抖、串行、失败不阻断编辑，也不得把 IndexedDB 当作运行时事实来源。
- **恢复必须同基准版本。** 激活时先做一次有界版本探测：
  - 当前磁盘版本 === `baseVersion`：把 `changes` 恢复为脏草稿，range store 按需加载原块；
  - 版本不同、文件删除或变为二进制：保留 IndexedDB 记录并不套用，标记 `外部修改 / 不可套用` 提示；用户只能放弃补丁并重载（删除记录）或继续保留。不得把补丁 rebase 到新版本。
- 已有普通文本未保存草稿仍优先恢复，不因盘上文件变大、超过阈值或出现解码错误被丢弃；其 `diskVersion` / `externalChange` 是运行时字段，不持久化为跨重启保存依据，保存时重新做冲突判定。
- 干净标签恢复时若磁盘已变大、缩小或出现解码错误，按同一决策切换完整正文 / 块模型 / 二进制预览，不建立空的或截断的可编辑正文。
- 旧版截断草稿仍不得保存；大文件块草稿与普通文本草稿互不覆盖。
- 成功保存、用户明确放弃修改、关闭并选择「不保存」或显式删除草稿后，清除对应 IndexedDB 记录；应用异常退出时保留记录供下次同版本恢复。

## 文件服务契约

### `readTextFileWindow`（沿用）

`IFileService.readTextFileWindow` 继续提供带版本、UTF-8 边界安全的有界窗口：

```ts
readTextFileWindow(params: {
  path: string;
  offset?: number;
  length?: number; // 默认且最多 256 KiB，最小 4
  expectedVersion?: string;
}): Promise<FileTextWindow>;
```

- 返回 `path`、实际 `offset`、`content`、`bytesRead`、`nextOffset`、`totalBytes`、`version`、`isBinary`、`eof`，以及可选 `hasDecodingErrors`。
- 读前 stat、读后 fstat + 路径 stat 双重校验；版本不匹配、删除或 atomic 替换返回 `FILE_TEXT_WINDOW_CHANGED`；参数非法返回 `FILE_TEXT_WINDOW_INVALID_RANGE`；非普通文件返回 `FILE_TEXT_WINDOW_NOT_FILE`。
- `offset` 落在**合法**多字节码点内部时回退到该码点起始；前置序列非法时保留请求 offset，把该非法字节当作确定的窗口边界。结束位置同理：只对合法码点回退，非法字节不回退。这样固定块的非法边界读取不会越过块起点或漏掉块尾。`nextOffset` 仍前进到完整码点之后；非法 UTF-8 以 U+FFFD 显示但字节位置继续推进。
- `hasDecodingErrors` 只描述本窗返回的原始字节；合法编码的 U+FFFD 为 `false`；不得用 `content.includes("\uFFFD")` 推断。
- 完整读取、块加载、普通文本冲突重载与恢复探测共用该方法；服务不保留常驻 handle 或整文件缓存。

### `commitTextFile`（新增）

`IFileService` 增加唯一文本提交方法（方法名固定）：

```ts
commitTextFile(params: {
  path: string;
  /** 另存为源；与 path 相同时不得设置，按普通保存处理。 */
  sourcePath?: string;
  /** 源 / 目标当前版本。null 表示必须不存在，且只允许 full。 */
  expectedVersion: string | null;
  /** 另存为目标版本：null = 必须不存在，string = 必须匹配；省略按 null。 */
  expectedTargetVersion?: string | null;
  write:
    | { kind: "full"; text: string }
    | { kind: "patches"; patches: Array<{ offset: number; deleteBytes: number; text: string }> };
}): Promise<{ path: string; version: string; totalBytes: number }>;
```

语义：

- **无 `sourcePath`：** `expectedVersion` 同时描述 `path` 的当前内容。字符串要求文件存在且版本一致；`null` 要求不存在，且 `write` 必须为 `full`。
- **有 `sourcePath`：** `expectedVersion` 必须是字符串并匹配源；`expectedTargetVersion` 描述目标（`null` 不存在 / 字符串匹配）。源和目标都必须通过版本检查后才提交。`sourcePath` 与 `path` canonical 相同时归一为普通保存：`expectedVersion` 描述目标，`expectedTargetVersion` 被忽略，即使传入也不参与校验。
- **无 `sourcePath`：** 两个版本字段不得同时出现，即不得设置 `expectedTargetVersion`（包括 `null`）；`expectedVersion` 已描述 `path`。
- **`full`：** 目标内容完全替换为 `text`；允许创建或覆盖，但必须满足对应版本条件。
- **`patches`：** 只允许 `expectedVersion` 为字符串（源已存在）。补丁坐标相对该版本源文件字节：
  - `offset`、`deleteBytes` 必须是非负安全整数，`offset + deleteBytes <= 源 totalBytes`；
  - 按 `offset` 升序应用；区间可以首尾相接，不得重叠；同一偏移的多个零长度补丁视为非法；
  - 未覆盖的源字节必须原样流式复制，补丁文本按 UTF-8 写入；
  - 不允许用补丁创建不存在的源 / 目标，也不允许在 `expectedVersion: null` 时使用补丁。
- 返回新目标的 `version` 与 `totalBytes`；该 `version` 是下一次保存的基准。

错误语义：

- `FILE_TEXT_COMMIT_CONFLICT`：字符串版本不匹配、期望存在的文件被删除、`null` 时目标已存在、提交期间源 / 目标版本或路径身份变化、create-if-not-exists 竞争失败。
- `FILE_TEXT_INVALID_PATCH`：补丁参数非法、越界、重叠、同一偏移重复、`null` 模式使用补丁，或 `sourcePath` / `expectedTargetVersion` 组合非法。
- `FILE_TEXT_NOT_FILE`：源或目标存在但不是普通文件（目录、设备等）。
- parent 不存在、权限、磁盘或远程断开等按普通保存失败返回，不得降级为覆盖或重建。

## Host 提交实现与锁

- `commitTextFile` 是 UI 唯一的文本写盘入口。旧 `writeTextFile` 仅保留给非 UI 调用方，使用同一把路径锁，但不提供版本冲突或既有文件 mode 保留保障；UI 不得调用它。
- Host 对 `path` 与 `sourcePath` 先规范化到 canonical 路径（已存在文件用 realpath；新目标用 realpath(parent) + basename），再使用现有 `@zcode/shared/node` 的 `withFileLock`。同一 canonical 路径只加一次锁；源与目标不同时按 canonical 字符串排序后依次加锁，反向释放，避免死锁。获取全部锁后、开始读写前，以及 pre-commit 时，重新解析用户原始路径并与捕获的 canonical 路径核对；若 symlink / 路径别名在等待锁期间或提交前改向，返回冲突，不写向捕获的旧目标。该有界复核不构成对外部进程的绝对 CAS。
- 锁以 canonical 路径字符串为单位，不创建 inode 级锁：硬链接别名各有不同 canonical 路径锁；提交通过 rename 替换一个目录项会分离硬链接关系，因此不保证硬链接别名之间互斥或同一旧 inode 版本全局仅成功一次。
- 锁内顺序固定：

```text
canonicalize(user paths) → lock(source,target sorted)
  → re-canonicalize captured user paths；不同则 conflict
  → stat / version / type / existence checks
  → build temp in target directory (O_EXCL)
      full: write text
      patches: 按 256 KiB 有界流复制源字节，替换补丁范围，保留未触碰原始字节
  → fsync(temp file) → fstat(temp identity: dev/ino/size/mtimeNs/mode)
  → close(temp)
  → pre-commit: re-canonicalize paths、重新 stat 源和目标，复核路径、版本、删除与 null 不存在
  → commit
      已存在目标: rename(temp, target)
      null 新建: link(temp, target) → unlink(temp)
  → fsync(directory) best-effort
  → stat(target)；必须匹配 temp dev/ino/size/mtimeNs，否则 conflict
  → return verified target version / totalBytes
```

- `readTextFileWindow` 与补丁边界探查均须循环处理短读，直到收齐请求字节或 EOF；`bytesRead <= 0` 视为 EOF。不得让短读截断合法 UTF-8 码点、误报解码错误或绕过 patch 边界检查。
- 提交 temp 在完成写入后通过 `chmod` 应用目标 mode，避免 `open(mode)` 被 POSIX umask 裁剪。Windows 不承诺 POSIX mode 位语义。
- 返回版本只能由已提交 temp 的身份与内容元数据复核通过后产生。rename/link 后若目标被替换，或同一 inode 被外部原地改写（size/mtimeNs 变化），返回 `FILE_TEXT_COMMIT_CONFLICT`，不得把外部版本当作本次保存结果。ctime 不参与该复核：link/unlink 本身会改变 ctime。
- `link` 用于原子 create-if-not-exists。平台或文件系统不支持 hard link（如 `EPERM` / `ENOTSUP` / 跨设备）时直接报保存失败，**不得**降级为「check 后 rename」或其他不安全创建方式。
- 失败、冲突或版本变化时删除 temp；不得留下可被误用的临时文件。
- 合作锁只覆盖遵守 `commitTextFile` / 旧 `writeTextFile` 的进程。外部程序不参与锁；最后一次 pre-commit 检查与 rename/link 之间仍存在极窄竞态，但提交后身份复核必须阻止服务把外部结果冒报为本次结果。不得声称绝对 CAS、跨进程零 lost update 或完全串行化外部编辑器。

## 状态所有者与事件顺序

### 所有者

| 状态                                                    | 所有者                                         | 说明                                                       |
| ------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------- |
| 打开标签、缓冲元数据、焦点、预览 / 固定                 | Files Editor Store                             | 仍是唯一所有者                                             |
| 普通文本 `diskVersion`、`externalChange`                | Files Editor Store                             | 运行时字段，不写入 localStorage 作为跨重启依据             |
| 大文件 `baseVersion`、`totalBytes`、`changes`、撤销历史 | Files Editor Store                             | 编辑草稿、脏态与全 buffer 历史唯一所有者；跨 split 共享    |
| 当前磁盘原块、offset、nextOffset、块版本、解码错误      | buffer 作用域 range store / hook               | 只拥有当前磁盘原块；不拥有用户修改、脏态或历史             |
| 块边界、补丁排序、脏态判定的纯函数                      | 共享纯模块                                     | 打开、编辑、保存、恢复共用；不得各自实现一套边界算法       |
| 文件字节、版本、总大小、解码错误                        | 对应工作区的 `IFileService.readTextFileWindow` | 服务内部完成版本与 UTF-8 校验                              |
| 保存完整性、锁、临时文件与原子提交                      | `IFileService.commitTextFile` / Host           | 唯一写盘所有者；UI 只发起                                  |
| 大文件块补丁草稿                                        | IndexedDB 适配器                               | 异步持久化，不是运行时事实来源；仅同 `baseVersion` 可套用  |
| 文件变化通知                                            | 既有 workspace / file watcher                  | 只设置提示；干净普通文本可按规则自动重载，脏文本不自动改写 |

```text
Files Editor Store（唯一编辑草稿 owner）
  ├─ normal text: { text, savedText, diskVersion, externalChange }
  ├─ large text:  { baseVersion, totalBytes, externalChange, changes, undo/redo }
  ├─ openIds / layout / active / preview
  └─ dirty = normal text 正文差 / large changes 任一 text !== originalText

Range store（按 buffer，跨 split 共享）
  ├─ currentBlock: { blockIndex, offset, nextOffset, content, version, totalBytes, hasDecodingErrors }
  ├─ requestSeq / watcher
  └─ 只替换当前磁盘原块；不接收、不保存用户修改

IndexedDB（异步）
  └─ large patch draft: { bufferId, path, workspace, baseVersion, totalBytes, changes, updatedAt }
```

### 打开、恢复与冲突重载共用决策

```text
打开 / 恢复激活 / 冲突重载
  → readTextFileWindow(offset=0, length≤256KiB)
  → binary? → PreviewPane
  → > 8 MiB? → block-model：range store 加载 block 0，Store 建立 baseVersion
  → ≤ 8 MiB? → 循环读取直到 EOF，汇总 hasDecodingErrors
       ├─ 全部 false → full-text：Store 建立 text/savedText/diskVersion
       ├─ 任一 true  → block-model：丢弃完整正文，坏块只读
       └─ 版本 / 大小变化 → 丢弃整次读取 → 冲突或重试
```

### 编辑、保存与冲突

```text
用户编辑当前块
  → FilesEditorStore.updateBlock(bufferId, blockIndex, text)
  → 更新 changes + 全 buffer 撤销历史
  → 立即变成脏；range store 不变

保存
  → 收集 changes 为 patches（按原 offset 升序；EOF append deleteBytes=0）
  → commitTextFile({ path, expectedVersion: baseVersion, write: patches })
       ├─ 成功 → Store 更新 baseVersion/totalBytes，清 changes/历史/IndexedDB
       │          → range store 失效当前块 → 按新版本重读
       └─ FILE_TEXT_COMMIT_CONFLICT → 大文件只提供「取消保留」或「放弃并重载」
```

### 外部变化

```text
激活 / 重新激活 → probe(有界首窗或 stat, expectedVersion)
  ├─ 干净普通文本 → 完整读取成功 → 替换正文 + savedText + diskVersion
  ├─ 脏普通文本   → externalChange=modified/deleted，保留草稿
  ├─ 干净大文件   → externalChange 提示，等待用户刷新
  ├─ 脏大文件     → externalChange 提示，不自动重基线
  └─ 删除         → externalChange=deleted，不自动重建
```

## 平台与传输

- `readTextFileWindow` 与 `commitTextFile` 都属于既有 `IFileService`（`ServiceChannels.File`）；Desktop 的 MessagePort、Web 与手机远控的 WebSocket / WebRTC 自动暴露同一 typed RPC。
- 远程工作区通过现有 `resolveFilesWorkspaceServices` 按 `workspaceIdentity?.trim() || workspacePath` 与 `remoteSessionId` 选择服务；不得把远程路径交给本机服务，断开时不回退、不 new Host。
- 每次窗口读取与提交都是普通请求 / 响应，不改变 `desktop-continuous` 实时流，也不改变手机 `web-remote-replayable` 恢复流；不把块或补丁放进任务队列、快照或广播。
- 离线、重连与重试沿用现有远程连接状态；提交不绕过鉴权、owner / lease 或工作区边界校验。

## 负面边界

- 不设置新的文件总大小上限，也不把大文件静默截断成完整可编辑正文。
- 不因 `> 8 MiB` 就把文件降级为整份只读；8 MiB 只切换全文模型与固定块模型。
- 不把未修改块、全文、当前窗口或撤销历史写入 localStorage；大文件补丁草稿只进 IndexedDB。
- 不做全文件搜索、全文件行号、全文件摘要或后台预读；搜索与定位只覆盖当前块。
- 不承诺跨块或全文件的 UTF-8 错误定位；`hasDecodingErrors` 只描述当前块。
- 不把合法编码的 U+FFFD 误判为解码错误，也不以 `content.includes("\uFFFD")` 代替字节级 `isUtf8`。
- 不编辑非法 UTF-8 块，不发送覆盖非法块的补丁，不对未触碰字节做解码后重新编码。
- 不提供大文件「把补丁强套到新版本」的冲突覆盖；只能取消保留或放弃并重载。
- 不在已保存文件路径消失时自动重建；只有显式 Recreate 的普通文本 `null + full` 或另存为到新目标可创建。
- 不新增文件系统绝对 CAS，也不宣称合作锁能串行化外部程序；但任何路径都不得写入不完整或局部内容。
- 不为大文件新建 Host、文件服务通道、实时流或第二份工作区状态；远程断开不回退本机。
- 不改变既有 48px 文件顶带、右滑手势、侧栏与次级菜单规格；交互 E2E 只写场景，未经授权不操作真实应用、CDP 或 UI 自动化。

## 验收与测试计划

### 单元 / 集成

1. **模式边界**：`≤ 8 MiB` 且 UTF-8 无损为完整正文；`8 MiB + 1` 为块模型；`≤ 8 MiB` 任一窗口非法时丢弃全文并转为块模型，坏块只读、其它块可编辑；空文件与 1 字节文本正常。
2. **块数学**：`step = 262140`；`blockIndex = floor(offset / step)`；边界落在合法 2 / 3 / 4 字节字符内部时 `actualStart` 向更大字节偏移最多移动 3 字节，落在非法字节时保持请求偏移；结束边界落在合法码点内部时由 4 字节探查确认实际结束位置并作为 `knownEnd` 传给裁剪；块连续、不重叠、无空洞；每块 ≤ 256 KiB；相邻块可分别增删；EOF append 使用零 `deleteBytes`。
3. **按需加载**：`> 8 MiB` 只读取首窗做决策，不扫描全文；直接跳到中间 / 尾部块只做有界探查与单块读取；raw 窗口未覆盖名义结束位置或含非法字节时，先做结束边界探查再按实际范围精确读取，探查与精确读取都钉住首窗版本，中途换版不得混版；切块不累积历史窗口；不建立全文缓存。
4. **非法块隔离**：坏块以 U+FFFD 显示且只读；块起点落在非法 continuation 串中时窗口按请求 offset 精确开始且不回退；合法相邻块仍可编辑；补丁不得覆盖坏块；提交后未触碰的原始坏字节逐字节保留；合法 U+FFFD 不被误判。
5. **完整编辑保存**：普通文本 `full` 带 `expectedVersion`；`expectedVersion: null` 只允许 `full` 且目标必须不存在；目录返回 `FILE_TEXT_NOT_FILE`。
6. **补丁校验**：越界、重叠、负数 / 非安全整数、同一偏移零长度重复、`null` 模式补丁、无 `sourcePath` 却带 `expectedTargetVersion` 返回 `FILE_TEXT_INVALID_PATCH`；`sourcePath === path` 归一为普通保存；首尾相接与零长度 EOF 追加合法；未覆盖字节保持原样。
7. **版本冲突**：源版本不匹配、删除、目标已存在但期望 `null`、提交期间版本变化返回 `FILE_TEXT_COMMIT_CONFLICT`；普通文本覆盖绑定弹窗观察版本，磁盘再变必须再次冲突。
8. **另存为**：源与目标都做版本保护；源变化 / 删除时失败；目标 `null` 不存在时创建，字符串匹配时覆盖；大文件用基于源版本的补丁，普通文本用完整正文。
9. **锁与提交顺序**：canonical 路径、源 / 目标排序双锁、锁内 check→stream temp→fsync→precheck→rename/link；`null` 新建使用 `link`，不支持时报错且不降级；旧 `writeTextFile` 同锁；外部程序竞态不被宣称为绝对 CAS。
10. **普通文本外部变化**：激活 watch 与重新激活探测；干净文本自动安全重载并更新 `diskVersion`；脏文本只设置 `externalChange`，正文与基准不变；删除不自动重建。
11. **大文件外部变化**：干净大文件只提示，刷新后接受新版本并夹紧块；脏大文件不自动重基线；保存冲突只提供取消保留 / 放弃重载，不提供强套补丁。
12. **撤销 / 分屏 / 切块**：跨块撤销重做按全 buffer 顺序；两个 split 共享同一修改与历史；切块、隐藏保活再激活都保留修改；保存成功后历史与补丁草稿清空。
13. **IndexedDB 草稿**：异步写入、去抖、失败不阻断编辑；不写 localStorage、不含全文；恢复时 `baseVersion` 一致才套用，版本不同或删除时保留并提示不可套用；保存 / 放弃 / 不保存后清除。
14. **保存入口覆盖**：保存、另存为、全部保存、关闭脏标签、标签保存按钮与脏标记都支持大文件；非法块、加载中窗口与预览不进入提交；所有入口只调用 `commitTextFile`。
15. **partial 保护**：不完整正文、非法块补丁、混合版本与替换字符永不写盘；提交失败后标签保持未保存态，关闭流程与全部保存停止。
16. **短读安全**：注入一次短读后，窗口继续读至请求长度或 EOF，合法 UTF-8 不误报且 `nextOffset` 在码点边界；patch 边界探查继续读取并拒绝切开合法码点；0 字节读退出而不死循环。
17. **提交结果归属**：注入 rename/link 后目标被替换、及同 inode 原地改写（size/mtimeNs 变化），commit 均返回冲突而非外部版本；正常 full、patch、Save As 和 null-create 返回版本与后续读取版本一致。
18. **mode 与路径复核**：POSIX umask `077` 下覆盖仍保留目标 mode；Win32 跳过 POSIX mode 位断言。锁等待期间 source/target 用户路径的 symlink 改向时冲突且不写捕获旧路径；pre-commit 再改向同样冲突。`lstat` 只把 ENOENT 视作缺失，其它错误透传。
19. **锁边界**：不同 service instance 对同 canonical path 的同版本并发只能一个成功；源/目标锁排序一致。硬链接别名不纳入 inode 级互斥保证，rename 可分离链接；旧 `writeTextFile` 仅非 UI 兼容入口，不保证 version/mode。
20. **工作区隔离**：两个工作区同路径、本地与远程同路径分别读取 / 提交，不串文件、不串版本；远程断开重试不回退本机。
21. **恢复**：大文件只恢复标签元数据；激活后按需读取并重新决策；普通文本草稿优先；旧截断草稿仍不可保存。

### 交互 E2E 场景（需要获准操作隔离应用后执行）

本轮只提交场景与结构测试；不得未经授权操作真实应用、CDP 或 UI 自动化。

1. Web 320px / 430px / 1280px 打开 `> 8 MiB` 文本：进入块编辑而非整份只读；只显示当前块与总大小；始 / 前 / 后 / 尾 / 百分比 / 块定位可用；搜索无结果文案是「当前块无匹配」；编辑当前块后标签变脏。
2. 同一文件切到 `≤ 8 MiB` 且 UTF-8 无损后重新打开：进入完整 Monaco 正文，保存正常。
3. `≤ 8 MiB` 文件含非法 UTF-8：自动进入块模型，坏块只读并显示替换字符，相邻合法块可编辑；保存后坏字节仍原样存在。
4. 编辑普通文本时外部改成 `> 8 MiB`：干净时自动重载为块模型；已脏时只提示，保存出现冲突，选「使用磁盘」转块模型，选「覆盖」写完整正文。
5. 大文件编辑期间外部修改：脏时只出现提示、不替换；保存冲突只有「取消保留」与「放弃并重载」，没有强套补丁。
6. 外部修改干净普通文本：文件自动重载且无冲突弹窗；外部删除后标签提示删除，不自动创建空文件。
7. 打开 `> 1 GiB` 稀疏文件并直接点「尾」：只加载并编辑最后一窗，界面保持可操作；切换到中间块不从头扫描。
8. 两个 split 同时打开同一大文件：在一边修改块，另一边看到同一脏态；撤销跨 split 生效；切换块或隐藏文件视图后修改仍在。
9. 大文件有未保存块修改时关闭标签：保存 / 不保存 / 取消可用；保存走补丁提交，不保存清除 IndexedDB 草稿。
10. 重启应用恢复大文件脏草稿：同版本时恢复块补丁并显示脏态；外部已改版本时保留草稿但提示不可套用。
11. 远程工作区断开后重试：错误可见、重试走同一远程工作区；恢复后读取 / 提交正常，不出现本机同名文件内容。
12. 既有 48px 文件顶带、任务面右滑与编辑器内右滑行为保持不变。
13. 大文件草稿处于 pending / blocked / error：文件视图顶部可见对应提示；blocked / error 提供显式「重试」；点「放弃草稿」必须弹出二次确认，确认后才删除 IndexedDB 记录，取消则保留原记录与提示。
14. 大文件补丁提交进行中：所有 split 的编辑器只读，状态行出现简洁「正在保存…」；保存期间点刷新不会替换当前块或丢失草稿；提交完成后恢复可编辑。
15. 大文件脏草稿遇到外部修改后点提示条「重新加载」或状态行刷新：先出现确认对话框；取消 / 保留草稿不改变正文与基准，确认重载才清除补丁并接受新版本。删除提示不提供「重新加载」，只保留草稿。
16. 大文件聚焦时菜单撤销 / 重做 / 查找路由到当前块，但不显示普通全文件的「行:列」状态栏；切到普通文本后菜单恢复原有行为。
17. 大文件「另存为」仍使用原生路径选择：选定新路径后通过补丁提交创建目标；目标已存在且版本不符时出现冲突，不静默覆盖。
18. 普通文本保存时磁盘文件已删除：冲突弹窗不提供「使用磁盘」，主按钮为「重新创建」；只有显式确认后才用完整正文创建文件。

### 验证命令

实现阶段至少执行：

```bash
pnpm typecheck
pnpm lint
pnpm architecture:check --changed
```

新增的 `node --test` 用例按仓库现有方式运行；若测试文件位于 `packages/services`、`packages/ui` 或 `packages/shared`，沿用对应包的 `TSX_TSCONFIG_PATH` 与 `.js` 说明符约定。没有可用的 E2E 基建时，交互场景只作为需授权的手动验收，不写成已通过。

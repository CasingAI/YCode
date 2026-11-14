# Spec: 文本文件（完整正文编辑、256 KiB 分窗 IO、非法 UTF-8 降级与提交冲突）

## 目标

合法 UTF-8 文本文件在文件工作台中始终是一份连续、完整的文档，不再按文件大小切换编辑模型：

- 不设「全文编辑大小阈值」。`10 MiB`、`20 MiB` 的合法 UTF-8 文本与 `10 KiB` 文本走同一条完整正文路径。
- 单次磁盘读取仍最多 256 KiB；分窗只是 IO 边界，不是用户看到的编辑单位。
- 完整正文由有界窗口按 `nextOffset` 顺序读入后合并；读取期间版本变化、删除或大小变化则整次失败，不提交半份正文。
- 二进制文件继续走只读预览；非法 UTF-8 文本保留现有固定块安全降级，避免把 U+FFFD 写回磁盘。
- 读取只有一道受控上限：首窗 `totalBytes > FILES_FULL_TEXT_MAX_BYTES`（`248 * 1024 * 1024 = 248 MiB`）直接返回 `too-large`，不读满全文，也不再按解码字符数做二次判定。该值是对「主动拒绝进入完整正文」的保守字节取舍（UTF-8 字节数 ≥ UTF-16 code unit 数），不是物理能力保证，也不保证字节数以内的文本一定放得下；作为背景，V8 单字符串上限约 512 MiB，Monaco 的 `LARGE_FILE_HEAP_OPERATION_THRESHOLD` 默认为 256M UTF-16 code unit；248 MiB 低于这两者并留出编辑余量，二者都不是本规范的产品阈值。`too-large` 显示明确的「文件过大，无法在完整编辑器中打开」错误，不静默切碎。
- 所有保存入口继续复用 `IFileService.commitTextFile`：普通文本提交 `full`，legacy 固定块缓冲提交 `patches`。
- Desktop / Web / 手机远控共用 `IFileService.readTextFileWindow` typed range IO 与 `expectedVersion`，不新增 Host、通道或文件流。
- legacy large-text 标签、块补丁草稿和 IndexedDB 记录继续可恢复；不因模型切换静默丢弃草稿。
- 全文草稿的 localStorage 配额风险必须处理：小草稿保留在 localStorage，超过本地存储预算的全文草稿写入 IndexedDB，并在恢复时合并。禁止只用 `catch` 吞掉写入失败。

本规范细化 `workspace-files.md` 的文本打开、编辑、保存、冲突与文件服务边界；不复制其主视图、标签、菜单与平台布局规则。

## 实现边界

| 边界       | 决定                                                                                                                                            |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| IO 窗口    | 单次 `readTextFileWindow` 最多 256 KiB；全文读取从首窗开始按 `nextOffset` 读到 EOF                                                              |
| 完整正文   | 合法 UTF-8 且首窗字节数不超过 `FILES_FULL_TEXT_MAX_BYTES`（248 MiB）→ 完整正文缓冲，可编辑、可搜索、有全文件行号                                |
| 读取上限   | 只有 `FILES_FULL_TEXT_MAX_BYTES = 248 MiB` 一个保守字节上限；由首窗 `totalBytes` 判定，不读满全文，也不再按解码字符累计做二次判定               |
| 背景边界   | 约 512 MiB 的 V8 单字符串上限与 Monaco heap 阈值只是解释 248 MiB 取值的背景，不是产品阈值或额外判定条件                                         |
| 二进制     | 首窗 `isBinary` 为 true → 既有只读 PreviewPane，不建立文本缓冲                                                                                  |
| 非法 UTF-8 | 任一次窗口 `hasDecodingErrors` 为 true → 保留固定块模型，坏块只读；其它合法块仍可编辑，补丁保存不触碰坏字节                                     |
| legacy     | 已存在的 large-text 标签、块补丁草稿与 IndexedDB 记录继续按固定块模型恢复；新打开不再按大小产生 large-text                                      |
| 保存       | 所有保存入口统一调用 `IFileService.commitTextFile`；完整文本用 `full`，legacy 固定块用基于原文件坐标的 `patches`；UI 不调用旧 `writeTextFile`   |
| 冲突       | 完整文本「覆盖」绑定弹窗观察到的版本；固定块不提供把补丁强套到新版本的覆盖，只允许取消保留或放弃并重载                                          |
| 外部变化   | 激活时 watch + 重新激活探测；干净完整文本安全自动重载；脏文本只提示、绝不覆盖草稿；干净 legacy 大文件提示后按需刷新；删除不自动重建             |
| 持久化     | 打开标签与完整文本小草稿在 localStorage；超过本地预算的完整文本草稿异步写入 IndexedDB；legacy 块补丁草稿仍只写 IndexedDB，按 `baseVersion` 恢复 |
| 平台       | Desktop 的 MessagePort 与 Web / 手机远控的 WebSocket / WebRTC 使用同一 `IFileService` typed RPC；不新增 Host、通道或文件流                      |

## 产品规则

### 读取决策

每个文本候选文件在打开、恢复、冲突重载或显式刷新时，先通过一次 `readTextFileWindow({ offset: 0, length: 256 KiB })` 获得 `totalBytes`、`version`、`isBinary`、`hasDecodingErrors` 与首窗内容。决策只此一处：

```text
文本候选 → readTextFileWindow(offset=0, length≤256KiB)
  ├─ isBinary → 既有只读二进制 PreviewPane（不建立文本缓冲）
  ├─ hasDecodingErrors → block-model：固定块安全降级，坏块只读
  └─ 合法 UTF-8
        ├─ totalBytes ≤ FILES_FULL_TEXT_MAX_BYTES
        │     → 按 nextOffset 读到 EOF（带首窗 version）
        │     → 全部窗口无解码错误 → full-text：一份连续完整文档
        └─ totalBytes > FILES_FULL_TEXT_MAX_BYTES
              → too-large：显示明确错误，不读取后续窗口、不切块
```

- 已知非文本路径仍先走现有预览分类，不读文本。
- 未知扩展名必须先由 window read 的 `isBinary` 决定，不能仅凭路径或大小区分文本与二进制。
- 第一个窗口已读取的字节不得丢弃重读；完整读取从 `nextOffset` 继续。
- `stat` 校验与版本检查在文件服务内部完成，调用方不自行拼版本或猜测文件大小。
- 文件服务对每次有界读取循环处理短读，直到填满请求长度或到达 EOF；0 字节读取结束本次读取。UTF-8 对齐、解码错误判定与窗口 `nextOffset` 必须基于实际收齐的字节。
- 首窗 `totalBytes` 是受控上限判断的权威来源；完整读取的每个后续窗口必须带首窗 `version`。任一窗口版本不匹配、文件消失或读取失败，整次读取失败，不提交半份正文。

### 完整正文可编辑

- 从首窗开始，按 `nextOffset` 顺序读取到 EOF；每个请求最多 256 KiB。
- 首窗内容直接作为第 0 段，不重读；后续窗口最多 `FILES_TEXT_WINDOW_READ_CONCURRENCY = 4` 个并发在途，但按计划序号提交，正文字节顺序不随完成顺序改变。
- 合并按实际 UTF-8 字节范围进行：每个窗口只追加「已提交连续前沿」之后的字节；名义窗口重叠 8 字节、服务最多回退 3 字节，保证实际覆盖区间连续、无空洞且不重复。裁切落到非码点边界时整次读取失败，不猜测。
- 在途与待提交窗口总数有界（≤ 4），不累积整份 Promise 列表；任一间窗口版本不匹配、缺失或读取失败，整次读取失败。
- 所有窗口 `hasDecodingErrors` 都不为真时，才建立完整正文缓冲；`text` 与 `savedText` 都是完整正文，不设置 `truncated`。
- 任一块返回 `hasDecodingErrors: true` 时，已拼接内容不得写入 `text` / `savedText`，也不得进入完整正文草稿；转为固定块模型，由块级只读遮住坏块。
- 判定依据只能是服务对原始字节的 UTF-8 校验结果；合法编码的 U+FFFD（`EF BF BD`）不是解码错误。
- 读取期间磁盘版本变化、被删除、被 atomic rename 替换或大小变化：整次完整读取失败，不得提交部分正文或混合版本内容。
- 唯一判定是首窗字节数：`totalBytes > FILES_FULL_TEXT_MAX_BYTES`（248 MiB）时不读后续窗口并返回 `too-large`；读取过程中不再按解码字符数做第二道权威判定。该上限只表示主动拒绝进入完整正文，不表示产品希望用户分块编辑。
- 全文搜索、行号、撤销 / 重做、跨行选择和连续编辑都作用于这一份完整正文，不再只覆盖当前块。

### 超过读取上限：明确错误

- 首窗 `totalBytes > FILES_FULL_TEXT_MAX_BYTES` 的合法 UTF-8 文本返回 `mode: "too-large"`，不读取后续窗口，不累计字符，也不自动转成固定块。
- 即使文件以 3/4 字节字符为主、解码后的字符数可能不大，也按字节保守拒绝；这是有意的内存取舍，不能让判定依赖读满全文。
- UI 在原路径打开一个不可保存的文本标签或恢复标签，`loadState = "error"`、`loadError = "too-large"`，显示明确的「文件过大，无法在完整编辑器中打开」提示；文件变小或出错后重试仍走同一读取决策。
- 错误状态不产生 `diskVersion`、`savedText` 或可编辑正文；不能保存、另存为或全量保存。
- 固定块模型不再是「大文件」的默认兜底；它只服务非法 UTF-8 与 legacy 标签，因此不存在把合法大文件静默切成 262140 字节块的路径。

### 非法 UTF-8：固定块安全降级

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

- `utf8BoundaryAtOrAfter` 只在 `nominalStart(i)` 位于一个合法 2–4 字节码点内部时向更大字节偏移对齐；合法码点起点与非法字节都保持请求偏移不动。不得为寻找「下一个合法起点」扫描任意长字节串。
- 因非法字节而使块起点落在非法序列内部时，该块按确定的原文件字节范围只读显示；服务不得为对齐而回退、丢弃或重新编码这些字节。
- 块之间连续、不重叠、无空洞；每块长度不超过 `BLOCK_STEP + 3 < READ_WINDOW`。任何编辑都不得改变其它块的原始坐标。
- 空文件、`totalBytes` 正好落在块边界、EOF 落在块中间都由上式覆盖；不额外做全文件边界表或全文件扫描。

#### 加载与裁剪

- 起点边界探查：加载目标块时先以 `offset = nominalStart(i)` 发一次最小窗口探查（最多 4 字节）。若返回 `offset < nominalStart(i)`，说明请求偏移落在合法多字节码点内部（服务只对合法码点回退，前置序列非法时保留请求 offset），此时 `actualStart(i) = 返回 offset + 首个码点字节长度`；否则 `actualStart(i) = nominalStart(i)`。相邻块加载时优先复用上一块确认后的实际结束位置。
- 正式块读取：`readTextFileWindow({ path, offset: actualStart(i), length: 256 KiB, expectedVersion })`。`actualStart(i)` 是合法码点起点或已确定的非法字节边界，服务必须按该 offset 返回，不得再向更小偏移回退。
- 结束边界探查：名义结束位置 `nominalEnd(i)` 可能落在合法多字节码点内部。对 `nominalEnd(i)` 发 4 字节探查：若返回 `offset < nominalEnd(i)`，`actualEnd(i) = 返回 offset + 首个码点字节长度`；否则 `actualEnd(i) = nominalEnd(i)`。末块直接到 `totalBytes`，不发探查。
- 精确复核：raw 窗口 `hasDecodingErrors` 为真，或 raw 窗口未覆盖 `nominalEnd(i)` 时，先做结束边界探查得到 `actualEnd(i)`，再精确读取 `[actualStart(i), actualEnd(i))`，并把 `actualEnd(i)` 作为 `knownEnd` 交给裁剪纯函数。
- 非法正文不得反推字节坐标；字节坐标只能来自服务返回的 `offset` / `bytesRead` 与边界探查结果。
- 版本钉住：边界探查与精确读取都必须携带首窗 `version`；探查或精确读取期间版本变化时不得混版。
- 当前块是 range store 唯一加载的磁盘原块；切块时整体替换，不累积历史块，不建立全文缓存。
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

- Store 用 `changes` 保存修改，同一块最多一条，按 `offset` 唯一；EOF 追加是独立的零长度项。
- 非法 UTF-8 块以 U+FFFD 显示且只读；该块不能产生修改记录，也不能被补丁覆盖。切换到合法块后仍可正常编辑。
- 固定块模型只加载当前块；搜索、行号与定位只覆盖当前块。这是非法 UTF-8 的安全降级，不再适用于合法大文本。
- 撤销 / 重做属于整个 buffer，按用户编辑顺序保存块变更历史，不复制全文。
- 保存成功或用户放弃修改后清空修改与历史，并以新文件版本重建块边界。

### 运行时正文 owner 与输入路径

- **唯一 owner 是 Files Editor Store。** 文本缓冲的运行时正文由 store 持有；挂载编辑器后，store 通过运行时绑定 `FilesTextDocumentBinding` 使用 Monaco 公开模型 API（`getValue` / `getAlternativeVersionId` / `setValue` / `getValueInRange` / `getValueLength`）读取与替换正文。Monaco 模型只是增量正文的存储后端，UI 不保存第二份可写正文，也不把 `getValue` 结果当作持续同步的缓存。
- **绑定按 model 单例，分屏共享。** 同一个 Monaco model 上的所有视图拿到同一个绑定对象；绑定身份就是版本域身份。Store 用 `documentAttachments` 记录仍挂载的视图数：第二个视图 attach 只增加计数、不重算基线；detach 只在最后一个视图离开时固化正文、记住基线并解绑。关闭任一分屏不得让仍存活视图失去权威正文。
- **保存基线按 model 版本域保留。** 最后视图卸载后，`savedDocumentVersionId` 仍按绑定对象记住；主题切换、拖组或重新分屏复用同一 model 时恢复该基线，撤销回保存点仍判 clean。换到新 model（旧模型已销毁或路径变化）时不得沿用旧替代版本号：干净缓冲以新模型当前版本为基线，脏草稿为 `null`。外部整体重写模型正文会主动丢弃旧基线。
- **每次局部输入只更新版本与脏态，不读全文。** `onDidChangeModelContent` 只发送 `noteTextDocumentChange(id)`：递增缓冲的 `documentRevision` 与会话级 `textChangeEpoch`，不调用 `getValue`、不做全文比较、不 JSON.stringify、不写 localStorage / IndexedDB。同一 model 的多个视图会各触发一次回调，Store 按 `notedDocumentVersionId` 去重，一次编辑只推进一次 revision / epoch。
- **脏态 O(1) 判定。** `isFilesBufferDirty` 在绑定时比较 `model.getAlternativeVersionId()` 与上次干净点保存的 `savedDocumentVersionId`；用户撤销 / 重做回到保存点会自然变回干净。未绑定的缓冲继续用 `text !== savedText`。撤销 / 重做本身由 Monaco 模型维护，不需要另一份历史。
- **外部正文替换是同步原子步骤。** 打开、恢复、磁盘重载、冲突后「使用磁盘」、`updateText` 全量替换等入口，先验证缓冲身份与（需要时的）干净状态，再同步调用绑定 `replaceText`（内部 `setValue`，带程序化写入抑制），同一次状态更新写入 `text` 回退快照、`savedText`（若为磁盘内容）与 `savedDocumentVersionId`。替换期间不可能插入用户输入。
- **保存快照显式获取。** 保存 / 另存 / 冲突探测 / 旧基线校验通过 `captureFilesTextSnapshot(buffer)` 一次性取得 `{ text, documentVersionId }`；`documentVersionId` 是同一同步时刻的替代版本号。提交成功时 `savedText` 用该 `text`，`savedDocumentVersionId` 用该版本号。提交时已携带版本号且绑定仍有效，`markSaved` 不再为此复制全文；保存 await 期间的新输入只改变模型的当前版本号，因此保存完成后仍为脏，正文与撤销历史不丢。
- **等待后的 stale 规则。** 磁盘重载、关闭后等待异步存储清理、外部探测等路径在 await 前记录起始绑定与 `documentVersionId`；await 后只有仍在同一绑定（同一版本域）时才比较版本号。任一侧未绑定或绑定已更换时回退比较显式正文快照，变化即视为出现新输入，丢弃旧结果；不同 model 的替代版本号数值相同也不能当作未变。
- **持久化使用显式快照协议。** `persist()` 在调用时刻通过 `snapshotFilesTextBuffer` 读取权威正文；持久化方必须订阅 `textChangeEpoch` 延迟调度，而不能在每次键入同步 persist。保存、关闭、页面隐藏等既有入口继续显式 `persist()` / `flush()`。计时只用于持久化去抖，不用于正文正确性。
- **长读取停止调度而不是只丢结果。** `readFilesTextForOpen` / `readFilesTextForSave` 接受可选的 `{ signal, isCancelled }`：打开、恢复、显式重开、外部重载把调用链已有的 `isCurrent` / `isCancelled` 谓词传入窗口流水线；谓词变真后不再发起新的 256 KiB 窗口请求，并以 `FilesTextReadAbortedError` 结束。取消只表示本次结果过期，调用方按「无结果」处理，不得归类为编码错误、文件缺失或版本变化；保存冲突读取路径不强制取消。
- **消费者读取投影而不是缓存。** Markdown 预览在渲染时快照正文；TypeScript workspace 条目在真正同步时通过 `readText` 读取快照；首行语言判定读取绑定的首行（最多 2048 字符）并保留 `text` 回退；状态栏、复制、查找、撤销继续直接使用 Monaco 模型。持久化草稿同样在 persist 时快照。
- **不要在批量状态更新中重复读正文。** `persistableDrafts`、保存、冲突、TS 同步等每个动作最多快照一次；渲染路径不得因标签脏点、布局或无关状态变化而读取全文。

### 保存、冲突与完整性

- **所有保存入口同一条路径。** 保存、另存为、全部保存、关闭脏标签、标签脏标记与文件菜单最终都调用 `IFileService.commitTextFile`；只读二进制、加载中预览与非法块不能进入补丁。
- **完整文本使用 `full`。** `expectedVersion` 取运行时 `diskVersion`；新建或未命名文件用 `expectedVersion: null` + `full`。
- **legacy 固定块使用 `patches`。** 只收集 `text !== originalText` 的有效变更，按原文件 `offset` 升序发送；补丁范围不得重叠，允许首尾相接；同一偏移的多个零长度补丁拒绝。没有有效变更时不调用提交，只清除脏态。
- **固定块提交期间暂时只读。** Files Editor Store 以 buffer 作用域保存唯一的提交 token；从目标版本探测前到提交结果应用并使旧窗口失效，禁止块输入、撤销、重做、放弃和异步草稿恢复。成功与失败都在 finally 中按 token 释放。完整文本提交期间仍允许继续输入，新输入保持未保存态。
- **成功提交后：** 用结果的 `version` / `totalBytes` 更新基准，清空修改、历史与 IndexedDB 补丁草稿；固定块使 range store 当前块失效，再从新版本按需加载当前块。
- **保存后的展示重载按新版本规范块起点：** 重载按保存前的块索引重新计算 `nominalStart(blockIndex)`，不得复用旧窗口的 `actualStart`。读取失败只影响展示，不回滚已提交的 `version` / `totalBytes`。
- **另存为改变路径后窗口 owner 立即切换：** 旧 owner 的窗口、块坐标与在途请求全部失效。
- **重载和关闭不得丢弃新输入。** 显式放弃重载先读取磁盘，读取成功且缓冲身份、正文或块编辑代次仍与发起时一致，才替换草稿。
- **完整文本冲突：** 保存前读取或提交返回版本不一致即冲突。弹窗观察到的版本必须绑定到「用编辑器覆盖」；磁盘在弹窗后再次变化时必须再次冲突。选择「使用磁盘」丢弃草稿并按同一读取决策重载。
- **固定块冲突：** 不提供「把补丁强套到新版本」的覆盖。源版本冲突时只能取消并保留草稿，或放弃草稿并按磁盘重载。
- **解码错误不得写回。** 完整正文发现任一窗口非法 UTF-8 时转为块模型，不把 U+FFFD 写回磁盘；固定块补丁不得覆盖非法块。服务提交补丁时，未被补丁替换的源字节必须逐字节流式复制。
- **已保存文件路径消失不自动重建。** `expectedVersion` 为字符串时，源 / 目标不存在即 `FILE_TEXT_COMMIT_CONFLICT`。只有用户显式选择「重新创建」才对完整文本使用 `expectedVersion: null` + `full`。
- **另存为源和目标都受版本保护。** 已有路径另存为传 `sourcePath`、`expectedVersion`（源）与 `expectedTargetVersion`（目标）。源版本已变化或删除时另存为失败。
- **`expectedVersion: null` 只允许 `full`。** 该模式要求目标不存在，服务用原子 create-if-not-exists 提交。
- **写前有应用内缓冲身份 guard。** 写盘前重新确认缓冲 id、路径、工作区身份、可保存状态、基准版本与请求身份未变。
- **部分内容永不写盘。** 不完整正文、加载中窗口、`too-large` 错误态、非法块、截断草稿与替换字符结果都不能进入 `full`；补丁只允许来自已加载且有效的块。

### 文件变化、watch 与刷新

- **激活时 watch，重新激活时探测。** 完整文本与 legacy 固定块缓冲在可见 / 激活时启动唯一 watcher；隐藏保活不额外监听。
- **干净完整文本安全自动重载。** 探测或 watch 发现版本变化时，按同一读取决策重新读取；只有完整读取成功且身份未变才替换正文、`savedText` 与 `diskVersion`。若磁盘变为非法 UTF-8 则转固定块；变为二进制则转只读预览；超过受控上限则转 `too-large` 错误态。
- **脏文本只提示。** 任何已修改文本在外部变化 / 删除时只设置 `externalChange` 并显示提示，绝不自动替换、重置基准或关闭标签。
- **干净 legacy 大文件提示后按需刷新。** 不自动重基线；用户刷新后重新取得版本并按新总大小夹紧当前块。
- **脏 legacy 大文件不自动重基线。** 外部变化只提示；旧补丁继续以原 `baseVersion` 判定，保存必冲突。
- **删除不自动复活。** 文件被删除时标记 `externalChange: "deleted"`，保留标签与脏草稿；不自动创建空文件、不自动保存、不自动关闭。
- 旧路径、旧工作区或旧请求序号的 watch / 探测结果不得写入新缓冲。
- 远程工作区断开时显示错误与重试入口；重试仍使用同一远程文件服务，不回退本机。
- Monaco 初始化失败时显示错误与重试入口；共享 loader 必须清除本次失败缓存。

### 恢复与持久化

#### 标签元数据与草稿分流

- **打开标签与完整文本小草稿仍在 localStorage：** `FilesPersistedSession` 保存标签元数据与小体积完整文本草稿。大文本（legacy 固定块）标签只保存 `id`、`preview`、`path`、`kind: "large-text"` 与工作区身份。
- **完整文本大草稿写入 IndexedDB，不写 localStorage：**
  - 本地预算：单个草稿 `text.length + savedText.length > FILES_TEXT_DRAFT_LOCAL_STORAGE_MAX_CHARS (1 MiB)`，或会话草稿总字符数超过 `FILES_LOCAL_STORAGE_SESSION_MAX_CHARS (4 MiB)` 时，超出部分不进入 localStorage。
  - 当前 schema 为 IndexedDB v3，同一数据库三个 object store：`drafts` 只存身份 / 标题 / epoch / `bodyRevision` / `savedRevision`，不存正文；`bodies` 与 `baselines` 各存 `{ storageKey, revision, text }`（`baselines.text` 即已保存基线）；主键都是 `storageKey`。
  - `storageKey = workspaceKey + \u0000 + remoteSessionId + \u0000 + (path ?? bufferId)`，其中 `workspaceKey = workspaceIdentity?.trim() || workspacePath`。IndexedDB 主键只使用 `storageKey`，不复用也不改写全局 `bufferId`。
  - `bodyRevision` 变化才写 `bodies`，`savedRevision` 变化才写 `baselines`；revision 未变时用 key-only `count(storageKey)` 检查对应 part 是否实际存在，缺失则在同一事务补写。正文变更不重写基线，基线变更也不克隆全文。
  - 一次 `save` 在 `[drafts, bodies, baselines]` 的同一个 readwrite 事务里写入元数据、正文与基线；事务 complete 才算成功，失败 / abort 保留旧记录，不出现 revision 已更新而正文没写的半状态。
  - 读取 v2 的整条记录时保持兼容：正文 / 基线 / revision 归一化后仍可读；但不能把它当作已按 v3 拆分，本次会话第一次 persist 必须对该 `storageKey` 强制 `save` 一次（`unverifiedParts`），由存储层按真实 store 内容原子拆分或补写缺失 part。
  - v1 记录主键是 `bufferId`；升级时按 `workspaceKey + remoteSessionId + (path ?? bufferId)` 重算 `storageKey` 后迁移，不能继续按旧主键匹配。
  - 读取时缺 part 或 part revision 与 metadata 不一致：按读取失败处理（warning、保留记录供后续重试），不得当成「没有草稿」，也不删除记录；下一次同 key 的 `save` 会补写。
  - localStorage 中的每个草稿同时记录 `updatedAt` epoch；同一 persist 的 localStorage 会话与 IndexedDB 溢出记录使用同一个 epoch，作为跨重启的合并依据。
  - 写入去抖、串行；失败只记录 warning，不阻断编辑，也不得把 IndexedDB 当作运行时事实来源。
  - 草稿变小、保存成功、用户放弃或标签关闭后，删除对应 `storageKey` 的三个 store 记录。
- **保存快照与备份快照彼此独立：** 保存提交快照只取 1 次；保存 await 期间继续输入触发的去抖备份属于独立快照，不能为了少读一次正文而暂停草稿保护。
- **localStorage 配额失败不得静默吞掉：** 写入失败时先把最大的本会话草稿移入 IndexedDB 并重试；仍失败则保留上一次成功会话并记录带路径的 warning，不能把失败当成已持久化。
- **legacy 块补丁草稿仍只进 IndexedDB：** 记录 `{ bufferId, path, workspace, baseVersion, totalBytes, changes, updatedAt }`，按同一身份规则隔离；不包含完整文件正文、当前窗口、未修改块或撤销历史。

#### 存储权威与合并

- localStorage 是同步基线，IndexedDB 是异步备份。每次 persist 先同步写入 localStorage 会话，再按同一 epoch 排队写 IndexedDB；唯一事实仍是 Files Editor Store。
- 读取 IndexedDB 时只能用会话内的 `workspaceKey + remoteSessionId + (path ?? bufferId)` 计算 `storageKey`，不得按全局 `bufferId`、仅路径或仅 workspace 猜测。记录自身的 `workspaceKey` / `remoteSessionId` / `storageKey` 必须与计算值一致才合并；不一致的记录忽略且不得删除，避免误删其它 owner 的草稿。
- **同一 id 的合并规则：**
  - localStorage 有草稿且没有 epoch（旧会话）：localStorage 胜出，清理同 `storageKey` 的旧 IndexedDB 记录。
  - 两边都有 epoch：`localStorage.updatedAt >= indexedDB.updatedAt` 时 localStorage 胜出并清理旧记录；只有 `indexedDB.updatedAt` 更大（例如 localStorage 配额失败后保留了旧会话，而 IndexedDB 已写入更新草稿）时才用 IndexedDB 覆盖。
  - localStorage 只有标签元数据、没有同 id 草稿：使用 IndexedDB 大草稿，这是超预算草稿的正常恢复路径，不得因此删除记录。
  - localStorage 与 IndexedDB 都没有：保留标签元数据，按现有规则在激活时读盘。
- 清理旧记录按 `storageKey` 定位；不同 `storageKey`、`workspaceIdentity` 或 `remoteSessionId` 的记录既不会互相恢复，也不会被本次合并删除。

#### 恢复

- 冷启动先同步读取 localStorage 会话（标签元数据 + 小草稿），再异步读取 IndexedDB 中这些打开标签对应的完整文本大草稿；读取是异步的，不能阻塞 UI。
- **运行态优先，不做硬性整体替换：** 异步读取完成时若 Files Editor Store 已有 `buffers` 或 `openIds`（读取期间用户新开文件、输入或变更布局），保留运行态，不调用 `hydrateSession`，也不得用超时、轮询或延迟假设替代这一判断。只有运行态仍为空时才水合持久化会话。
- IndexedDB 读取失败或不可用时继续使用 localStorage 会话并记录 warning；不得因此清空本地标签或小草稿。不可用环境（如无 IndexedDB）按“没有记录”处理，其它读取失败必须保留可重试错误，不能当作“没有草稿”。
- 完整文本大草稿恢复后仍是脏的完整正文；其 `diskVersion` 是运行时字段，不持久化为跨重启保存依据，首次保存重新做冲突判定。
- **legacy large-text 标签：**
  - 标签有仍保留的 IndexedDB 块补丁记录时，恢复为固定块模型并按现有规则探测 `baseVersion`；版本一致才套用补丁，版本不同只提示不可套用。
  - 读取明确返回“没有记录”且磁盘已是合法 UTF-8 时，按新决策转为完整正文；磁盘仍是非法 UTF-8 时保持固定块。
  - 读取保留记录本身失败（非不可用环境）时，必须保持原有 large-text 标签并暴露可重试错误，不得因磁盘当前合法就转成完整正文，否则旧块补丁草稿会失去归属；用户重试后仍按同一读取决策执行。
  - 显式「放弃草稿并重载」或保存成功后清空记录；不得在模型切换时静默删除记录。
- **异步 owner 校验：** 恢复读取与重新打开在每次 await 之后都要重新确认缓冲仍在、`path`、工作区身份 key（`workspaceIdentity?.trim() || workspacePath`）与 `remoteSessionId` 都未变化，才允许套用结果；任一变化则丢弃本次结果，不写回新 owner。
- 已有完整文本未保存草稿仍优先恢复，不因盘上文件变大、超过本地预算或出现解码错误被丢弃；盘上出现解码错误时只提示或转固定块，草稿正文仍保留到用户明确放弃。
- 干净标签恢复时若磁盘已变大、缩小、出现解码错误或超过受控上限，按同一决策切换完整正文 / 固定块 / 二进制预览 / `too-large` 错误态，不建立空的或截断的可编辑正文。
- 旧版截断草稿仍不得保存；legacy 块草稿与完整文本草稿互不覆盖。
- 成功保存、用户明确放弃修改、关闭并选择「不保存」或显式删除草稿后，清除对应持久化记录；应用异常退出时保留记录供下次恢复。

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
- `offset` 落在**合法**多字节码点内部时回退到该码点起始；前置序列非法时保留请求 offset，把该非法字节当作确定的窗口边界。结束位置同理：只对合法码点回退，非法字节不回退。
- `hasDecodingErrors` 只描述本窗返回的原始字节；合法编码的 U+FFFD 为 `false`；不得用 `content.includes("\uFFFD")` 推断。
- 完整读取、legacy 块加载、冲突重载与恢复探测共用该方法；服务不保留常驻 handle 或整文件缓存。

### `commitTextFile`（沿用）

```ts
commitTextFile(params: {
  path: string;
  sourcePath?: string;
  expectedVersion: string | null;
  expectedTargetVersion?: string | null;
  write:
    | { kind: "full"; text: string }
    | { kind: "patches"; patches: Array<{ offset: number; deleteBytes: number; text: string }> };
}): Promise<{ path: string; version: string; totalBytes: number }>;
```

语义与错误码保持既有实现：

- 无 `sourcePath`：`expectedVersion` 同时描述 `path` 的当前内容；字符串要求存在且版本一致，`null` 要求不存在且只允许 `full`。
- 有 `sourcePath`：`expectedVersion` 必须匹配源；`expectedTargetVersion` 描述目标；源和目标都通过版本检查后才提交。
- `full` 完全替换目标内容；`patches` 只允许 `expectedVersion` 为字符串，区间按 `offset` 升序、可首尾相接、不得重叠，未覆盖字节原样流式复制。
- 错误码：`FILE_TEXT_COMMIT_CONFLICT`、`FILE_TEXT_INVALID_PATCH`、`FILE_TEXT_NOT_FILE`；parent 不存在、权限、磁盘或远程断开按普通保存失败返回。

## 状态所有者与事件顺序

### 所有者

| 状态                                                | 所有者                                         | 说明                                                                                                 |
| --------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 打开标签、缓冲元数据、焦点、预览 / 固定             | Files Editor Store                             | 仍是唯一所有者                                                                                       |
| 完整文本 `text` / `savedText` / `diskVersion`       | Files Editor Store                             | 运行时唯一正文与基准；`text` 是最近一次显式快照                                                      |
| 完整文本增量正文与脏态版本                          | Files Editor Store + 绑定 Monaco 模型          | owner 仍是 Store；模型只作为增量正文后端，`documentRevision` / `savedDocumentVersionId` 是运行时投影 |
| 完整文本 `loadError: "too-large"`、`externalChange` | Files Editor Store                             | 运行时字段，不写入持久化作为跨重启依据                                                               |
| legacy 大文件 `baseVersion`、`changes`、撤销历史    | Files Editor Store                             | 编辑草稿、脏态与全 buffer 历史唯一所有者；跨 split 共享                                              |
| 当前磁盘原块、offset、块版本、解码错误              | buffer 作用域 range store / hook               | 只拥有当前磁盘原块；不拥有用户修改、脏态或历史                                                       |
| 文件字节、版本、总大小、解码错误                    | 对应工作区的 `IFileService.readTextFileWindow` | 服务内部完成版本与 UTF-8 校验                                                                        |
| 保存完整性、锁、临时文件与原子提交                  | `IFileService.commitTextFile` / Host           | 唯一写盘所有者；UI 只发起                                                                            |
| 完整文本大草稿                                      | IndexedDB 适配器 + 会话持久化控制器            | 异步备份，不是运行时事实来源；`storageKey` 只由会话 owner 计算                                       |
| legacy 块补丁草稿                                   | IndexedDB 适配器                               | 异步持久化；仅同 `baseVersion` 可套用                                                                |
| 文件变化通知                                        | 既有 workspace / file watcher                  | 只设置提示；干净文本可按规则自动重载，脏文本不自动改写                                               |

```text
Files Editor Store（唯一编辑草稿 owner）
  ├─ full text:  { text, savedText, diskVersion, loadState, loadError, externalChange }
  ├─ runtime document: { document, savedDocumentVersionId, documentRevision }
  │    └─ 绑定 Monaco 公开模型 API；局部输入只 bump revision，不读全文
  ├─ legacy block: { baseVersion, totalBytes, externalChange, changes, undo/redo }
  ├─ openIds / layout / active / preview
  └─ dirty = 绑定时 altVersionId !== savedDocumentVersionId / 未绑定时 text !== savedText
             / legacy changes 任一 text !== originalText

Range store（按 buffer，跨 split 共享）
  ├─ currentBlock: { blockIndex, offset, nextOffset, content, version, totalBytes, hasDecodingErrors }
  ├─ requestSeq / watcher
  └─ 只替换当前磁盘原块；不接收、不保存用户修改

IndexedDB v3（异步）
  ├─ drafts: { storageKey, bufferId, path?, title, workspaceKey, remoteSessionId, updatedAt, bodyRevision, savedRevision }
  ├─ bodies: { storageKey, revision, text }
  ├─ baselines: { storageKey, revision, text }
  └─ legacy patch draft（独立记录）: { bufferId, path, workspace, baseVersion, totalBytes, changes, updatedAt }
```

### 打开、恢复与冲突重载共用决策

```text
打开 / 恢复激活 / 冲突重载
  → readTextFileWindow(offset=0, length≤256KiB)
  → binary? → PreviewPane
  → hasDecodingErrors? → block-model：固定块安全降级
  → totalBytes > FILES_FULL_TEXT_MAX_BYTES? → too-large 明确错误
  → 否则循环读取直到 EOF，汇总 hasDecodingErrors
       ├─ 全部 false → full-text：Store 建立 text/savedText/diskVersion
       ├─ 任一 true  → block-model：丢弃完整正文，坏块只读
       └─ 版本 / 大小变化 → 丢弃整次读取 → 冲突或重试
```

### 完整文本编辑、保存与冲突

```text
用户局部输入
  → Monaco onDidChangeModelContent（不调用 getValue）
  → Store.noteTextDocumentChange(id)
       → documentRevision += 1（标签脏点重渲染）
       → textChangeEpoch += 1（持久化订阅者去抖调度；同步路径不读正文）
  → dirty = model.getAlternativeVersionId() !== savedDocumentVersionId（O(1)）
  → 撤销 / 重做由 Monaco 维护，回到保存点自动变干净

保存
  → captureFilesTextSnapshot(buffer) → { text, documentVersionId }
  → commitTextFile({ path, expectedVersion: diskVersion, write: { kind: "full", text } })
       ├─ 成功 → Store 写入 text/savedText，savedDocumentVersionId = 快照版本
       │          保存 await 期间的输入让当前版本号不同，保存后仍为脏
       └─ FILE_TEXT_COMMIT_CONFLICT → 冲突弹窗；覆盖绑定观察到的版本

外部替换（重载 / 使用磁盘 / 恢复）
  → 先确认身份与干净快照
  → 同步 binding.replaceText(text) → Store 写入 text/savedText + 新版本基线
  → await 后版本号已变 → 丢弃旧结果，不用缓冲 text 判断
```

### legacy 固定块编辑、保存与冲突

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
       └─ FILE_TEXT_COMMIT_CONFLICT → 只提供「取消保留」或「放弃并重载」
```

### 持久化与恢复

```text
局部输入（不持久化）
  → Store.noteTextDocumentChange → textChangeEpoch += 1
  → 持久化 owner 订阅到 epoch 变化 → 去抖调度（不读正文）
  → 保存 / 关闭 / pagehide / visibility=hidden 仍显式 persist / flush

每次 persist(state)
  → 在调用时刻快照权威正文（snapshotFilesTextBuffer / capture）
  → snapshot session（标签 + 全部脏草稿）
  → 给本次草稿打同一个 updatedAt epoch
  → 按本地预算拆分：小草稿留在 localStorage，超过预算的完整文本草稿进入 IndexedDB desired 集
  → localStorage 写入失败 → 移出最大草稿重试 → 仍失败则 warning，保留上次成功会话
  → desired 集整体替换上一次意图；不再 desired 的 storageKey 进入待删除集合
  → IndexedDB 去抖、串行 reconcile：
       save 成功 → 再核对一次当前 desired：
         ├─ 该 storageKey 仍是同一次 desired → 完成
         ├─ 已有更新 revision → 继续写最新值（最新编辑胜出）
         └─ 已 clean / 关闭 / 移出预算 → 删除刚写入的记录
       delete 成功 → 再核对一次当前 desired：若期间重新变脏，继续写入最新值
       失败 → 记录 warning；下一次 persist 重新进入待处理集合

冷启动
  → 同步读 localStorage session（标签 + 带 epoch 的小草稿）
  → 按会话身份计算每个打开标签的 storageKey
  → 异步读取匹配 storageKey 的 IndexedDB 完整文本草稿
  → 同 id 按 epoch 合并：本地缺 epoch 或本地 epoch 不早于 IndexedDB 时本地胜出并清理旧记录；
    IndexedDB 更新时使用 IndexedDB；只有标签元数据时直接使用 IndexedDB
  → 合并后：运行态为空才 hydrateSession；读取期间已有新开文件 / 输入则保留运行态
  → 激活时按需读盘并重新做读取决策

页面隐藏 / 卸载
  → visibilitychange=hidden 或 pagehide → persist（同步写 localStorage）+ 启动 best-effort flush
  → 浏览器不保证异步 IndexedDB 在卸载前完成；不添加超时，也不宣称异步落盘一定成功
```

## 平台与传输

- `readTextFileWindow` 与 `commitTextFile` 都属于既有 `IFileService`（`ServiceChannels.File`）；Desktop 的 MessagePort、Web 与手机远控的 WebSocket / WebRTC 自动暴露同一 typed RPC。
- 远程工作区通过现有 `resolveFilesWorkspaceServices` 按 `workspaceIdentity?.trim() || workspacePath` 与 `remoteSessionId` 选择服务；不得把远程路径交给本机服务，断开时不回退、不 new Host。
- 每次窗口读取与提交都是普通请求 / 响应，不改变 `desktop-continuous` 实时流，也不改变手机 `web-remote-replayable` 恢复流。
- 离线、重连与重试沿用现有远程连接状态；提交不绕过鉴权、owner / lease 或工作区边界校验。

## 负面边界

- 不按文件大小把合法 UTF-8 文本切成固定块；256 KiB 只限制单次读盘。
- 不把 `FILES_FULL_TEXT_MAX_BYTES`（248 MiB）当成物理能力保证或可调产品阈值；它只是主动拒绝进入完整正文的保守字节上限，也不引入累计字符数的第二道判定。
- 不因 `> 8 MiB` 就把文件降级为整份只读或固定块编辑。
- 不在超过受控上限时静默切块；必须显示明确错误。
- 不把完整正文、legacy 当前窗口或撤销历史写入 localStorage；大全文草稿只进 IndexedDB。
- 不把未修改块或全文重复写入 IndexedDB；只持久化脏草稿。
- 不在 localStorage 配额失败时静默丢草稿；不得只用 `catch` 吞掉错误。
- 不把合法编码的 U+FFFD 误判为解码错误，也不以 `content.includes("\uFFFD")` 代替字节级 `isUtf8`。
- 不编辑非法 UTF-8 块，不发送覆盖非法块的补丁，不对未触碰字节做解码后重新编码。
- 不提供 legacy 固定块「把补丁强套到新版本」的冲突覆盖；只能取消保留或放弃并重载。
- 不在已保存文件路径消失时自动重建；只有显式 Recreate 的 `null + full` 或另存为到新目标可创建。
- 不新增文件系统绝对 CAS，也不宣称合作锁能串行化外部程序；但任何路径都不得写入不完整或局部内容。
- 不为文本读取新建 Host、文件服务通道、实时流或第二份工作区状态；远程断开不回退本机。
- 不改变既有 48px 文件顶带、右滑手势、侧栏与次级菜单规格；交互 E2E 只写场景，未经授权不操作真实应用、CDP 或 UI 自动化。

## 验收与测试计划

### 单元 / 集成

1. **完整正文边界**：合法 UTF-8 的 `> 8 MiB`（含 10174816 字节、399194 行 JSON）按窗口读到 EOF，得到一份完整可编辑正文；`FILES_FULL_TEXT_MAX_BYTES` 以内全部为 `editable`；`+1` 为 `too-large` 且只读首窗一次；空文件与 1 字节文本正常。
2. **不切块**：合法 UTF-8 文本不会创建 `large-text` 缓冲、不会调用块加载、不会把 262140 字节块当作编辑单位；搜索、行号与连续编辑覆盖整份正文。
3. **非法 UTF-8 降级**：首窗或后续窗口出现解码错误时丢弃已拼接正文，转为固定块；坏块只读、其它块可编辑；保存后坏字节原样保留；合法 U+FFFD 不被误判。
4. **二进制**：`isBinary` 为 true 时进入预览，不建立文本或固定块缓冲。
5. **完整编辑保存**：完整文本 `full` 带 `expectedVersion`；`expectedVersion: null` 只允许 `full` 且目标必须不存在；目录返回 `FILE_TEXT_NOT_FILE`。
6. **补丁校验（legacy）**：越界、重叠、负数 / 非安全整数、同一偏移零长度重复、`null` 模式补丁、无 `sourcePath` 却带 `expectedTargetVersion` 返回 `FILE_TEXT_INVALID_PATCH`；未覆盖字节保持原样。
7. **版本冲突**：完整文本覆盖绑定弹窗观察版本，磁盘再变必须再次冲突；legacy 补丁源版本不匹配只允许取消或放弃重载。
8. **受控上限错误态**：`too-large` 打开后 `loadState = "error"`、`loadError = "too-large"`，不可保存；文件变小后重试走同一决策并恢复正常。
9. **localStorage 配额**：大全文草稿被移出 localStorage 并写入 IndexedDB；localStorage 抛 `QuotaExceededError` 时不丢草稿、不静默吞错，重试后仍能保留小草稿与标签。
10. **IndexedDB 恢复**：冷启动先读 localStorage，再合并 IndexedDB 完整文本草稿；读取失败只 warning 并保留 localStorage 会话。异步读取期间新开文件并输入时，读取完成后不得整体替换运行态；运行态为空时正常水合。
11. **legacy 草稿保留**：恢复 large-text 标签时，有保留块补丁记录就保持固定块并可恢复；明确无记录且磁盘合法时转完整正文；读取保留记录失败时保持 large-text 标签和可重试错误，不因磁盘合法转完整正文；模型切换不删除记录。
12. **外部变化**：干净完整文本自动重载并更新 `diskVersion`；脏文本只提示；删除不自动重建；变为二进制 / 非法 UTF-8 / 超受控上限时按同一决策转换。
13. **撤销 / 分屏**：完整正文跨分屏共享正文与撤销历史；legacy 固定块跨块撤销重做按全 buffer 顺序；保存成功后历史与草稿清空。
14. **保存入口覆盖**：保存、另存为、全部保存、关闭脏标签、标签保存按钮与脏标记都覆盖完整文本与 legacy 固定块；`too-large`、非法块与加载中窗口不进入提交。
15. **partial 保护**：不完整正文、`too-large` 错误态、非法块补丁、混合版本与替换字符永不写盘。
16. **短读安全**：注入一次短读后，窗口继续读至请求长度或 EOF，合法 UTF-8 不误报且 `nextOffset` 在码点边界。
17. **提交结果归属**：注入 rename/link 后目标被替换、及同 inode 原地改写，commit 均返回冲突而非外部版本。
18. **工作区隔离**：两个工作区同路径、本地与远程同路径分别读取 / 提交，不串文件、不串版本。
19. **恢复**：完整文本大草稿恢复后仍为脏正文；legacy 标签只恢复元数据；旧截断草稿仍不可保存；恢复 / 重开在异步读取后按 `path`、工作区身份与 `remoteSessionId` 重新校验，期间改名或切换 owner 的结果不写回。
20. **持久化竞态**：IndexedDB save 在途时草稿变干净、被放弃或标签关闭，flush 后不得残留旧记录；连续产生更新编辑时最终记录必须是最后一次 desired 正文，不能回退到较早版本。
21. **存储权威**：同 id 的 localStorage 草稿在缺少 epoch 或 epoch 不早于 IndexedDB 时胜出并清理旧记录；只有标签元数据时恢复 IndexedDB 大草稿；localStorage 写失败留下的旧会话被更新的 IndexedDB 记录覆盖。
22. **身份隔离**：不同 `storageKey`、`workspaceIdentity` 或 `remoteSessionId` 的草稿不会互相恢复，也不会在合并清理时被误删；IndexedDB 写入 / 删除失败只 warning，后续 persist 仍可重试。
23. **卸载**：`visibilitychange=hidden` / `pagehide` 触发 persist 与 best-effort flush；测试只断言已发起的同步 localStorage 写入和队列 flush，不宣称异步 IndexedDB 一定在卸载前完成。
24. **每键零全文读取**：模拟连续局部输入只触发 `noteTextDocumentChange`；`snapshotText` / `getValue` 调用次数为 0，dirty 由替代版本号 O(1) 得出，标签脏点及时更新。
25. **撤销 / 重做及时**：输入后变脏；撤销回保存点变干净；重做再次变脏；不需要额外全文比较。
26. **保存快照一致**：`commitTextFile` 收到的是保存开始时的完整正文；保存 await 期间继续输入后 `savedText` 仍是提交正文、缓冲仍为脏；另存为迁移使用同一快照。
27. **await 后 stale 防护**：磁盘重载 / 放弃后异步清理 / 外部探测在等待期间输入（仅替代版本号变化）时丢弃旧结果，不覆盖新正文；Markdown 预览、TS workspace 与持久化读取到的都是显式快照而非陈旧 `text`。
28. **超长单行**：首行语言判定最多读取 2048 字符，不因 50 MiB 单行文本在普通渲染中扫描全文；50 MiB 多行文本的保存与快照仍只发生一次。
29. **分屏共享 model**：同一 buffer 的两个视图绑定同一个 model；关闭任一视图后另一个视图继续编辑，dirty、快照与 revision 仍准确；只有最后一个视图卸载才固化正文并解绑，不丢数据。
30. **同模型重建与换模型**：主题切换 / 拖组重建同一个 model 后保存基线仍有效，撤销回保存点变 clean；旧 model 已销毁时换新 model，同一数值的替代版本号不被当作同一版本域，脏草稿保持 `null` 基线。
31. **reload 版本域**：await 期间挂载了新 model 时按同一绑定比较版本号，否则回退正文快照；不同 model 的相同版本号视为变化；未绑定期间挂载等价正文可安全替换，出现输入则放弃旧结果。
32. **同步与预览只读一次**：一次 TypeScript workspace 同步对每个 entry 最多调用一次 `readText`；Markdown 预览只在正文代次 / 正文快照变化时重新取快照，布局、外部变化提示等无关状态更新不复制全文。
33. **长读取停止调度**：`isCancelled` 在第 2 个窗口后变真时不再发起后续窗口请求，读取以 `FilesTextReadAbortedError` 结束；打开 / 恢复 / 显式重开 / 外部重载把它当作过期结果，不产生编码、变盘或缺失错误；保存冲突读取不强制取消。
34. **IDB v3 拆分与迁移**：`drafts` 不含正文；仅 `bodyRevision` 变化写 `bodies`、`savedRevision` 变化写 `baselines`；metadata 已存在但 part 缺失时 key-only `count` 命中并补写；v2 整条记录首次 persist 强制拆分；v1 重算 `storageKey`；缺 part 或 revision 不一致只 warning 且不删除记录。
35. **快照与备份独立**：保存提交只取 1 次快照；保存 await 中继续输入触发的去抖备份独立取快照，不因少一次读取而暂停草稿保护。

### 交互 E2E 场景（需要获准操作隔离应用后执行）

本轮只提交场景与结构测试；不得未经授权操作真实应用、CDP 或 UI 自动化。

1. Web 320px / 430px / 1280px 打开 10174816 字节 JSON：直接进入完整 Monaco 正文，全文件搜索、行号和连续编辑可用；标签变脏后保存正常。
2. 同一文件在其它编辑器修改后再打开：按版本冲突或干净自动重载处理，不出现固定块视图。
3. 打开含非法 UTF-8 的文本：进入固定块模型，坏块只读并显示替换字符，相邻合法块可编辑；保存后坏字节仍原样存在。
4. 打开超过受控上限的合法文本：显示明确的「文件过大，无法在完整编辑器中打开」错误，不显示 262140 字节块。
5. 编辑 9.7 MiB 全文后强制退出并重启：同版本时从 IndexedDB 恢复完整草稿并保持脏态。
6. 外部删除 / 修改完整文本：脏时只提示不替换；保存出现冲突；删除提示不提供自动重建。
7. 两个 split 同时打开同一完整文本：在一边修改，另一边看到同一脏态；撤销跨 split 生效。
8. 远程工作区断开后重试：错误可见、重试走同一远程工作区；恢复后读取 / 提交正常。
9. 既有 48px 文件顶带、任务面右滑与编辑器内右滑行为保持不变。

### 验证命令

实现阶段至少执行：

```bash
pnpm typecheck
pnpm lint
pnpm architecture:check --changed
```

新增的 `node --test` 用例按仓库现有方式运行；若测试文件位于 `packages/services`、`packages/ui` 或 `packages/shared`，沿用对应包的 `TSX_TSCONFIG_PATH` 与 `.js` 说明符约定。没有可用的 E2E 基建时，交互场景只作为需授权的手动验收，不写成已通过。

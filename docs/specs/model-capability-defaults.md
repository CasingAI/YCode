# Spec: 未识别模型的默认输入能力与推理档位

## 目标

当模型 ID 匹配不到任何内置规则时，系统仍然要给它一份可用的输入能力与推理档位。当前兜底是「纯文本 + 开关式推理」，这是**悲观兜底**：它假设新模型都退回到最保守的形态。事实相反——近年新发布的模型基本都支持图片输入，也基本都支持分档调节推理强度；不支持多模态、不支持调节推理的才是少数。

悲观兜底有两个实际代价：

- **能力被写错，附件被静默剥离。** `supportsImage: false` 会让运行时在请求前把图片替换成占位文本（`apps/zcode-cli/packages/core/src/runtime/helpers/media-capability.ts`），而占位文本只进模型请求，用户在对话里看不到任何提示。用户贴了图，模型收到的是一段文字。
- **推理档位被压成二选一。** 兜底档位表是 `["disabled","enabled"]`，用户只能开关思考，无法在「低 / 高」之间取舍。

本 spec 把兜底改成**乐观兜底**：未识别模型默认支持文本与图片，推理档位默认提供 `关闭 / 低 / 高` 三档。

## 产品规则

- **未识别模型的输入能力：文本 + 图片。** 内置兜底规则的 `inputFormat` 为 `supportsText: true`、`supportsImage: true`。
- **未识别模型的推理档位：`disabled` / `low` / `high`。** 兜底 `optionSpecs.reasoningLevel.values` 为 `["disabled","low","high"]`，并保留 `disabled` 作为「关闭思考」选项——`disabled` 在各协议的 map 里是「不注入思考参数」的稳定分支，删掉它会让未知模型无法关闭思考。
- **兜底仍然排在解析链的最底层。** 兜底规则的 `modelMatch` 是 `.*`，但它排在 `modelConfigRules.modelRules` 的**第一位**，后续更具体的规则继续 overlay 上去。因此任何已知模型的专属事实都不会被兜底改写：显式声明 `supportsImage: false` 的模型（如 `glm-5` 系列）仍然是纯文本，显式声明 `supportsImage: true` 的模型仍然是多模态。
- **显式事实永远压过兜底。** 解析顺序（后者覆盖前者）：

  ```mermaid
  flowchart TD
    A["个人精确规则（手动勾选）"] --> B["discovered 精确规则（账号 / CLI Proxy 上游同步）"]
    B --> C["站点规则（baseUrl + apiType）"]
    C --> D["API 类型规则"]
    D --> E["模型家族 / ID 规则"]
    E --> F["内置兜底规则 modelMatch=.*<br/>文本 + 图片；档位 disabled/low/high"]
    F --> G["Effective Model Config"]
    G --> H["CLI 请求前的媒体投影<br/>按 supportsImage / supportsPdf / supportsVideo 决定是否剥离"]
    G --> I["Composer 思考档位选择器<br/>默认档位 = high"]
  ```

- **PDF 与视频仍然默认关闭。** `supportsPdf` 除了决定请求里是否携带 PDF 文件块，还决定 Read 工具走不走「把 PDF 原文交给模型」这条通道（`apps/zcode-cli/packages/core/src/tool/handlers/read-pdf.ts`）。翻转它会连带改变 Read 工具的行为，属于另一件事，本次不碰。视频输入仍是少数派，保持关闭。
- **其它能力维持保守默认。** `supportsJsonSchemaOutput`、`supportsNativeWebSearch`、`supportsMidConversationSystem` 仍是 `false`：这三项的少数/多数分布与多模态不同，不能顺带翻转。
- **上下文窗口与最大输出维持现状。** 兜底仍是 `contextWindow: 200000`、`maxOutputTokens.max: 32000`。

## 状态所有者与唯一实现

兜底能力只有一份实现：`config/provider/zcode-builtin.json` 的 `modelConfigRules.modelRules[0]`（`modelMatch: ".*"`）。它被以下消费方共用，不存在第二份默认值：

- `packages/provider` 的 `parseZCodeBuiltinModelConfigRules` → `ModelConfigRules.resolve`，产出 Effective Model Config。
- `packages/provider` 的 `resolveDefaultReasoningLevel`（`packages/provider/src/model-selection-config.ts`）在档位表含 `high` 时默认 `high`，所以未识别模型的默认思考档位是「高」。
- 桌面端与 CLI 都从这份 Effective Config 派生：桌面经 `packages/services/src/model-provider/legacyModelProviderSerialized.ts` 投影成 CLI 的 `modalities.input`，CLI 在请求前按 `supportsImage` / `supportsPdf` / `supportsVideo` 做媒体投影。

UI 侧的草稿初值（`packages/ui/src/settings/model-provider-section/ProviderModelMetadata.ts`）同步为「图片默认开」，保证在 Effective Config 缺 `inputFormat` 时的展示与运行时口径一致。

## 发送前的附件能力提示

模型不接收的媒体会在请求前被替换成占位文本，而占位文本只进模型请求，用户在对话里看不到。输入框下方因此常驻一行小字，告知用户哪些附件不会到达模型。

- **位置**：输入壳之外、底部 dock 的留白里（`ConversationComposer` 的 `chat-composer-region` 内，`chat-composer-input-surface` 之下）。不进入输入壳，避免和输入区抢注意力；桌面与手机 Web 共用同一处。
- **触发条件**：草稿里存在附件，且该附件的媒体类型不在当前模型的有效输入能力内。判定口径与运行时的媒体投影一致——能力缺省即不支持，只有显式为 `true` 才算支持。
- **类型范围**：只有会被媒体投影拦截的类型参与判定（图片、PDF、视频）。纯文本与其它文件不受影响。
- **模型未解析出来时不提示**：目录未加载、正在切模型时无法判断能力，此时不把「还不知道」说成「不支持」。
- **不出现时不占空间**：没有需要提示的内容时这一行不渲染，输入框位置不变。
- **文案**：一行 `text-ui-sm`（12px），主色为 `foreground-subtle`。`text-ui-xs` 是 10px，按 DESIGN.md「UI font tokens」只留给徽标与极弱元信息，中文句在这个尺寸已经难读，因此不用于这一行。模型 ID 按 DESIGN.md 的等宽要求单独用 `font-mono` 渲染，因此文案拆成前后两段拼接：「当前模型 」+ 等宽模型 ID +「 不接收{kinds}，这些附件不会发送」。`{kinds}` 是被拦下的类型名列表。

## 不变量

- 兜底规则必须留在 `modelRules` 的**第一位**。把它挪到后面会让它覆盖所有已知模型的专属事实，等于把所有模型都变成多模态。
- 未识别模型的能力只能通过「新增更具体的规则」或「用户手动勾选」来改，不得在 UI 草稿层或运行时再写一份默认值。
- 档位表顺序表示从低到高，`disabled` 在最前。默认档位由 `resolveDefaultReasoningLevel` 唯一决定，档位表里存在 `high` 即默认 `high`。
- 手动模式（关闭「智能配置」）写入的个人精确规则仍然压过一切，兜底不得回写。

## 负面边界

- 不改 `docs/specs/model-selection-default-level.md` 定义的默认档位规则；本 spec 只改兜底档位表的**内容**。
- 不改 `modelApiRules` / `providerSiteRules` 里按协议和站点给出的推理参数 map，只改兜底档位表。
- 不新增「自动探测模型是否支持图片」的运行时探针。
- 不改运行时媒体投影逻辑本身（本 spec 只改变喂给它的能力事实）。

## 验收场景

1. 新增一个内置规则未收录的模型（如 `gpt-6-sol`）→ 智能配置解析出的 Effective Config 里 `supportsImage: true`、`supportsText: true`；UI 弹窗「输入类型」里「图片」默认勾选。
2. 上述模型切换推理档位 → 档位表为 `关闭 / 低 / 高`，默认档位为「高」。
3. 命中显式 `supportsImage: false` 的模型（如 `glm-5-air`）→ 仍然是纯文本，兜底翻转没有改写显式事实。
4. 命中显式 `supportsImage: true` 的模型（如 `glm-4.6v`）→ 仍然是多模态。
5. 用户给未知模型手动关掉「图片」并保存 → 个人精确规则生效，该模型回到纯文本，且不会被兜底改回。
6. 未知模型附加一张图片发送 → 图片进入 provider 请求，不再被替换成 `[Media omitted from provider request ...]` 占位文本。
7. 未知模型附加一个扫描版 PDF 发送 → PDF 仍按 `supportsPdf: false` 被剥离（本次不翻转 PDF）。
8. 未知模型附加一个 PDF（模型不接收 PDF）→ 输入框下方出现小字「当前模型 {model} 不接收PDF，这些附件不会发送」；附加图片（模型默认接收图片）→ 不出现这行提示。
9. 模型未解析出来时附加图片 → 不出现提示行，不把未知说成不支持。
10. `pnpm typecheck`、`pnpm lint` 通过，provider 与 ui 侧新增用例通过。

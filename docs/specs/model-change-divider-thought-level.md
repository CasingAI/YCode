# 模型切换分隔线带思考档位

## 范围

时间线上的 `modelChange` 分隔线（`TimelineMarkerRowView` 的 modelChange 分支），以及子代理会话
上方那条「正在使用 X」——它就是 source-less 的 modelChange marker。

不覆盖：输入区模型胶囊、编辑冻结显示、Subagent 卡片表头、协议 schema、投影层写入。

## 所有权

- 数据已经有了：`timelineMarkerPayloadSchema` 的两个 modelChange 分支都要求 `toThought: z.string()`，
  投影层在两处发射点都写入 `config.thought`。缺的只是渲染层没读它，本规范不改协议与投影。
- 拼词的唯一产地是 `packages/ui/src/v4/modelChangeThoughtLabel.ts`：纯函数，注入
  `Pick<IntlInstance, "formatMessage">`，不碰 store / intl 实例 / DOM。
- 档位值查思考控件同一张映射表（`thoughtLevelLabelId`）。表里没有的值原样显示——
  那是 provider 自定义的档位名，藏起来比显示更难查。档位先 trim 再查表。
- 分隔符是字面量 `·`，与 `conversationEditFrozenDisplay` 同一写法，不导出常量。

## 展示规则

- 档位只落在 `to` 这一段：`模型已切换 A → B · 低`。`from` 段不带档位——切换记录要回答的
  是「现在跑在什么档位上」，不是「刚才跑在什么档位上」。
- source-less 分支同样带：`正在使用 B · 低`。
- 档位缺席或只有空白时只说模型名，不留悬空的分隔符。
- 模型组场景（[model-group.md](model-group.md)）：比较与展示的都是钉死的实际成员，不是组名。
  新会话选组的首次钉死必须走 source-less 分支（`ModelSelected` 带 `previousModelSelection: null`），
  `toThought` 填钉死补上的默认档位，档位表为空写空串。中途重钉换人按普通「已切换」分支落
  实际从 → 实际到；两次实际模型相同、或只改档位不落。

## 换行

标签 span 本来就是 `min-w-0 break-words`，本来就会换行。本规范**不改**分隔线外壳
（`MarkerDividerRow`）的任何一个类名：那是 compact / forkNotice / goalVerify / modelChange
四种 marker 共用的壳，动它就是动全部四条分隔线。

## 负面边界

- 不加断点、不加隐藏逻辑、不改横线（两侧 `h-px flex-1`）的显隐。
- 不改模型名的取名规则（`formatModelChangeLabel`：内置家族只显示模型名，套餐型 provider 带
  连接模式后缀，自定义 provider 显示「名字/模型」）。分节线的模型名维持现状。
- 不动 i18n：档位词复用工具条已有的 `chat.toolbar.thoughtLevel.value.*`，不新增词条。
- 不改只读分享时间线（`ConversationShareReadonlyTimeline` 对 modelChange 一律显示通用文案，
  本就没有模型名）。

## 验收

- 子代理会话上方的分隔线显示 `正在使用 OpenCode Go/space-bunny-free · 低`（英文
  `Using … · Low`），档位词随 UI 语言切换。
- 有来源的切换显示 `模型已切换 A → B · 低`。
- 列很窄时分隔线整体换行，两侧横线仍在，容器不溢出。

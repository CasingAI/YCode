# Spec: 实验特性开关与「对话问题导航」的默认关闭（experimental features / turn navigator）

## 目标

会话左侧的「对话问题导航」（问题刻度 rail）此前无条件启用，带来三类非渲染层开销，长会话下明显吃性能：

1. **自动全量补拉历史**：容器宽度 ≥864px 时 `ConversationTimeline` 的 hydration effect 自动调 `onLoadAllOlder()`，投影窗口从 tail（约 60 行）膨胀成整段会话，此后所有 O(rows) 派生计算都按整段会话付费。用户没有显式操作。
2. **每秒重建全部 hover 预览**：`renderUnits` 的 memo 依赖含 `liveNowMs`（运行期 1Hz 推进），导致 `items` 每秒重建；`buildConversationTurnNavigatorItems` 对每个 unit 把该轮全部 assistant 文本 join、正则切段、全局替换空白后才截断到 220 字符。实测 800 轮 ≈ 18ms/次、2000 轮 ≈ 38ms/次。
3. **每次滚动强制同步布局**：`handleScroll` 无 rAF 合帧，`syncTurnNavigatorViewport` 先写 6 个 mask 样式、紧接着读视口与被挂载行的 rect（写后立即读），每个滚动事件强制一次整棵消息树重排。

本改动把该功能收进设置页「实验特性」，做成**默认关闭**的开关，并让关闭状态真正停用上述开销，而不只是隐藏 UI。

## 产品规则

- **默认关闭**。`conversationTurnNavigatorEnabled` 在 `appSettingsSchema` 中 `.default(false)`，既有用户的 `setting.json` 缺该字段也解析为 `false`。
- **开关关闭 = 功能整体停用**，四类工作全部不做：
  - 不补拉整段历史（不调 `onLoadAllOlder`）；
  - 不监听容器尺寸（该 observer 只服务于分页资格判定）；
  - 不构建问题目录行 id 集合与 rail 虚拟项映射；
  - 滚动时不做视口 rect 扫描、不写 `turnNavigatorViewport` 状态。
- **遮罩不受开关影响**：`syncMessageLayerMask` 的淡出是 composer 遮挡的既有行为，开关关闭时照常执行。「写样式后不紧跟读」正是消除强制重排的关键。
- **开关打开时行为与改动前一致**：不改活动项判定、不改 O(n) Map 重建、不给预览加惰性；本次只做「关掉」。
- **跨窗口与手机 Web 实时同步**：在任一窗口改开关，其他窗口与手机远控不刷新即跟随。实现上只把本字段加入既有广播的触发条件，**不扩广播 payload**（见「接口」中的理由）。
- **分享选择流程不受影响**：分享面板独占左 rail 时（`hideTurnNavigator`）仍隐藏导航器；这是与开关无关的第二个隐藏条件，两者含义不同、不合并。

## 接口

- `packages/shared/src/validationAppSettings.ts`：`appSettingsObjectSchema` 加 `conversationTurnNavigatorEnabled: z.boolean().default(false)`；`appSettingsPatchSchema` 加 `.optional()` 同名字段。默认值的唯一权威定义在这里。
- `packages/shared/src/protocol.ts`：`AppSettings` 加 `conversationTurnNavigatorEnabled?: boolean`。**不进入** `appRuntimePreferencesChangedBroadcastPayloadSchema`。
- `packages/ui/src/settings/ExperimentalFeaturesSection.tsx`：`{ turnNavigatorEnabled, onTurnNavigatorEnabledChange }`，`SettingsGroupCard` + `SettingsRow` + `Switch`。
- `packages/ui/src/SettingsPage.tsx`：从 `sharedSettings` 读取（`=== true` 判真），经 `runSettingsActionAsync({ featureId: "settings.conversation", action: "toggle_turn_navigator" })` 写回。
- `packages/ui/src/settings/settingsPageConfig.ts`：新增分区 `{ id: "experimental", groupId: "basics" }`，跟随「基础」分组末尾渲染；`settingsNavigation.ts` 的 `SettingsSectionId` 与 `isSettingsSectionId` 同步登记 `experimental`。
- `packages/ui/src/v4/conversationTurnNavigatorHelpers.ts`：`shouldHydrateConversationTurnNavigatorDirectory` 增加必填入参 `turnNavigatorEnabled`，为 false 时直接返回 false——补页门控收敛成一个可单测的纯函数。
- `packages/ui/src/v4/ConversationTimeline.tsx`：新增 prop `turnNavigatorEnabled`（默认 `false`），是关闭态的唯一门控点（hydration effect、容器宽度 observer、`turnNavigatorQueryRowIds`、`turnNavigatorVirtualItems`、`syncTurnNavigatorViewport` 的 rect 段、渲染条件）。
- `packages/ui/src/hooks/useSettingService.ts`：广播触发条件增加 `typeof patch.conversationTurnNavigatorEnabled === "boolean"`。**payload 保持两个字段不变**——payload 语义是 agent 运行时偏好，会一路流进 CLI 协议（`server-types` 等处为必填 boolean），扩字段要连改 agent 侧；而接收端（`Root.tsx`）收到广播后本来就只做 `refreshAppSettings()` 从 `setting.json` 重读 + 幂等同步，因此本字段只需让广播「响一声」即可完成各端 UI 同步。

## 状态与时序

```
设置页改开关
  updateSharedSettings({ conversationTurnNavigatorEnabled })
    ├─▶ settingService.update() ──▶ ~/.zcode/v2/setting.json（唯一持久化所有者）
    └─▶ broadcast「响一声」（payload 不变）
          ├─▶ 本窗口 store 通知 → useSettings() 重渲染
          └─▶ BroadcastHub 转发其他 Host 进程
                └─▶ Root.refreshAppSettings()（重读文件，不再 send → 无回环）
                      └─▶ SessionPane 重读偏好 → ConversationTimeline turnNavigatorEnabled
                            ├─ false：不补页、不监听宽度、不建目录、滚动不读 rect
                            └─ true ：行为与改动前完全一致
```

- 偏好所有者：`settingService`（`setting.json`）；renderer 只读快照，不自行推导。
- 门控所有者：`ConversationTimeline` 的 `turnNavigatorEnabled` 一处判定，`SessionPane` 只做传递，不重复加判定分支。

## 验收场景

1. 设置页「基础」分组末尾出现「实验特性」，进入后开关为关闭态；长会话左侧不出现刻度 rail。
2. 关闭态滚动长会话做 Performance 录制：scroll handler 内不再出现读 rect 引起的 forced reflow，Layout 时间较改动前明显下降。
3. 关闭态不再发生由导航器触发的全量历史补拉（不再连发 rowsRange 直到 `hasMore = false`）。
4. 打开开关：rail 出现，刻度数量、活动项放大、hover 预览、点击跳转与改动前一致。
5. 桌面双窗口（或桌面 + 手机 Web 远控）：任一端改开关，另一端不刷新即跟随。
6. 重启应用后开关状态保持。
7. 分享选择流程仍由分享面板独占左侧 rail，无回归。

## 验证

- 已执行：`node --import tsx --test packages/ui/test/conversationTurnNavigatorGate.test.ts`（4 项全通过：默认关闭、patch 可单独写入、关闭时不补页、开启后仍受宽度与补页资格约束）。
- 已执行：`pnpm lint`（0 error；72 个 warning 全部是既有告警。其中 `shared/src/protocol.ts:5`、`shared/src/validationAppSettings.ts:3`、`SettingsPage.tsx:279-280` 三处位于本次改动文件，但都在文件导入区，与本次新增的 schema 字段、类型字段和组件分支无关）。
- 已执行：`pnpm architecture:check --changed`（0 违规）。
- 已执行：`npx oxfmt --check` 覆盖本次改动文件（全部合规）；`npx tsc -p packages/ui/tsconfig.json --noEmit --incremental false` 完整重检 ui 源码，报出的错误全部位于本地既有改动 `app-shell/WorkspaceShellLayout.tsx`，本次改动文件零错误。
- **未执行**：场景 1～7 的浏览器实测。原因：工作区既有未提交改动 `packages/ui/src/app-shell/WorkspaceShellLayout.tsx` 存在 JSX 不配平（tsc / esbuild / rolldown 三方一致报错），`pnpm dev:web` 在依赖扫描阶段即失败，UI 无法构建。该文件与本次改动无关，未作修改。
- **未执行**：`pnpm typecheck` 全仓结论不可用——`tsc -b` 因 tsbuildinfo 判定工程「已是最新」而整体跳过，需先修复 `WorkspaceShellLayout.tsx` 后在干净树重跑。

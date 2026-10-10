# Spec: 声音与提醒设置（Sounds & Notifications）

## 目标

在系统设置页的独立「声音与提醒」分区里，为任务完成 / 任务失败 / 等待审批 / 等待输入四个行为提供**按行两级配音**：每行先选风格包（一级，相当于模型选择里的供应商），再选该风格包里的具体音效（二级），四行互相独立。选中任一下拉即播放一次试听，不满意重选，不提供试听按钮与音量调节。音源为 uisfx 系列 12 风格包 × 78 音效全量引入。

## 背景

- 最初全仓只有 `task-notification-pop.mp3` 一个写死音效（`packages/ui/src/assets/notification-sounds/`），四个行为共用一种声音，无法区分。
- 窗口聚焦时系统通知与提示音整条被丢掉（Desktop `desktopNotifications.ts` 前台直接 return，Web `document.hasFocus()` 就 return），前台任务完成完全静默。
- instant-app 有 `public/assets/sounds/uisfx/{pack}/{cue}.mp3`（12 包 ×78 cue，CC0）的系列音源，但只是全局一维切换、不支持逐行为配音。本次取其音源、做更细的绑定。
- 修订（按行两级）：第一版把风格做成了顶部唯一的全局单选、每行只给 4 个候选音，不符合“模型选择式”（每行独立先选风格再选音效）的要求，且选项远少于整套音效。本次改为四行各存一对 `{pack, cue}`，12 包 78 音效全量端过来。

## 产品规则

1. **四行为事件固定**：`completed`（任务完成）、`failed`（任务失败）、`permission_request`（等待审批）、`elicitation_request`（等待输入）。`feedback_update` 只保留类型兼容，不配音、不在设置页出现。闲时任务复用同一套映射，不单独配。
2. **按行两级、行间独立**：每行一级选风格包（12 个），二级选该风格包下的具体音效（78 个）。完成行用 glass、失败行用 arcade 互不影响；没有顶部全局风格选择。
3. **选中即试听**：任一下拉 `onChange` 先持久化再播放一次新音；试听穿透总开关与声音开关（`force` 预览），保证关着通知也能听。切换某行风格时保留该行已选音效（各包 cue 同名，直接沿用并试听新风格）。
4. **无音量调节**：不引入分轨滑杆、总闸、audio-bus；播放音量沿用浏览器/系统默认。
5. **新音不替代旧默认**：`task-notification-pop.mp3` 保留为回退默认（映射缺失/资源损坏时兜底），不删除。
6. **前台也响、后台不重复**：窗口聚焦时由 hooks 侧直接按映射播放；窗口失焦时走系统通知 + 通道回放。同一事件只响一次（见状态所有者）。
7. **goal 迭代静默保持**：`docs/specs/task-notification-goal-iteration.md` 的静默集合不变——被静默的迭代中间帧不产 payload，自然也不配音；`verified` 补发帧正常配完成音。
8. **老数据自动迁移**：第一版存的全局风格（`zcode-notification-sound-pack`）与 v1 字符串映射（`{version:1, completed:"success"}`）在读取时自动拼成按行 `{pack, cue}`（v2），用户无感；全局风格键保留只读迁移用，不再写入。
9. **二级音效列表按可用高度滚动**：78 个音效的二级列表高度由共享二级菜单的「弹层在视口中剩余可用高度」决定（Radix `--radix-dropdown-menu-content-available-height`），不写死像素或行数。窄屏列表矮、桌面列表高，超出即在菜单内部滚动；宽度仍按内容撑开，受可用宽度与 `max-w-72` 约束。对齐 `workspace-shell-responsive-layout.md` 的既有原则——浮层各段不各自写死限高，由容器/视口兜住，避免嵌套滚动区把列表拦腰截断。

## 状态所有者与数据流

```text
设置页 (SoundsSectionContent，每行风格+音效双下拉)
  └─ zustand store (notificationSoundMap: 每行 {pack, cue})
       └─ localStorage (zcode-notification-sound-map, 版本化 JSON v2)
            └─ 播放器 (taskNotificationSound.ts: playSoundForStatus 按行解析 / previewSystemSound)
```

- 映射事实的唯一所有者是 `packages/ui/src/lib/taskNotificationPreferences.ts` 的 localStorage 读写 + 非法值回退（非法 pack/cue 回退该行默认 `{minimal, 默认cue}`）+ v1 迁移；store 只做内存镜像，不另起写入路径。
- 音源目录 `packages/ui/src/assets/system-sounds/{pack}/{cue}.mp3`（12 包 ×78，与上游同名）；`systemSoundCatalog.ts` 手写类型与语义，936 个静态资源 import 组成的 URL 表由 `packages/ui/scripts/generate-system-sound-assets.mjs` 生成为 `systemSoundAssets.generated.ts`（构建时解析为 URL，按需加载，JS 只多 URL 字符串）。
- 前台播放：`useTaskNotifications`（终态 + 待交互）与 `useOffPeakTaskNotifications` 在产出 payload 后，若窗口聚焦则直接调用 `playSoundForStatus(status)`，不经过 IPC。聚焦判断复用各 platform 的现有语义（Desktop 任一窗口 focused、Web `document.hasFocus()`），判断逻辑收口到播放器内部，hooks 只传 payload。
- 后台播放：`desktopNotifications.ts` 只弹静音系统通知，`TaskNotificationSound` 通道携带 `status` 回 renderer 播放；Web 端 `showTaskNotification` 失焦路径同样按 `status` 播放。前台已播的事件不会再走通道（前台根本不调 `showTaskNotification` 的发声分支），天然不重复。
- 系统通知文案、点击跳转、3 秒去重、zod 校验、goal 静默判定全部保留现状。

## 接口

- `packages/ui/src/lib/systemSoundCatalog.ts`：`SYSTEM_SOUND_PACKS`（12 成员常量 + 中英文 label，顺序与中文名照抄上游：简约/柔和/玻璃/机械/录音室/禅意/自然/梦幻/弹性/科幻/街机/电影）、`SYSTEM_SOUND_CUES`（78 全集）、默认选择（completed→{minimal,complete}、failed→{minimal,error}、permission_request→{minimal,mention}、elicitation_request→{minimal,notification}）、`formatSystemSoundCueName()`（`double-click`→`Double Click`，供无专属文案的 70 个音效展示）、`resolveSoundAssetUrl(pack, cue)`。
- `taskNotificationPreferences.ts`：版本化 JSON `zcode-notification-sound-map` 升到 version 2（值为按行 `{pack, cue}`）；`getEffectiveSoundSelection()` 合并默认；v1 字符串值 + 旧全局 pack 键做只读迁移。
- `taskNotificationSound.ts`：`playSoundForStatus(status)`（查总开关+声音开关+按行选择）、`previewSystemSound(pack, cue)`（无视开关，设置页试听用，签名不变）。旧 `playTaskNotificationSound()` 保留为兼容入口。
- 设置 UI：`SoundsSectionContent` 删掉顶部风格行，四行每行换成风格+音效双下拉（`controlLayout="wide"`）；store 切片（`notificationSoundSlice.ts`）删掉全局 pack 字段；`SettingsPage.tsx` 接线同步；遥测沿用 `settings.sounds` 的 `change_sound_pack` / `change_sound_for_status`。
- i18n：`settings.sounds.*` 扁平键新增 8 个风格名与两级描述，中英同步；78 个音效名只给已有的 8 个配专属文案，其余显示处理后的英文原名（中英同一文案）。

## 验收场景

- 设置→声音与提醒无顶部风格行；每行有两个下拉，一级 12 个风格，二级 78 个音效；完成行选 glass+success、失败行选 arcade+error，互相不影响，刷新保留。
- 二级音效列表在视口内滚动，列表底端不越过视口下沿；桌面宽高视口比手机窄屏露出更多行，同一份 78 项在两个视口下都可滚到最后一项。
- 改任一下拉关闭后立刻听到一次新音；关掉通知总开关后改下拉仍能试听出声。
- 老用户（localStorage 里有全局 glass + v1 字符串映射）打开后四行自动都是 glass 配原音效，无报错；手改脏数据（非法包/名）回退该行默认。
- 窗口聚焦时任务完成播完成行自选的声音；en-US/zh-CN 无缺 key；`pnpm typecheck` 与 `pnpm lint` 通过。

## 负面边界

- 不做音量调节、不做试听按钮（仍是选中即播一次）。
- 仍只做任务四态，更新就绪、发送失败 toast、高频发送音等不碰；闲时任务复用同一套按行映射。
- 78 个音效名只给 8 个配中英文案，其余显示英文处理名，不在这次里做 70 条翻译。
- 二级列表不写死高度，也不为「露出半行」之类的滚动暗示补装饰：高度跟着视口可用高度走，溢出与否由弹层自身滚动表达。桌面宽高视口下同一份列表比窄屏长是预期结果，不额外加固定上限把它压回去。
- 936 个 mp3（约 6.9MB）进包是预期的，音频按需加载；不转格式，沿用 mp3；CC0 声明文件随附。
- 不碰 Web Notification 权限索权、不改通知文案与点击跳转、不改 goal 静默规则。

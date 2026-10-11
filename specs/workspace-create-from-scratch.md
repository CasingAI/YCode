# Spec: 从空目录新建工作区（Create Workspace from Scratch）

空态 composer 的 workspace 切换菜单里，「从空目录开始」让用户不依赖系统目录选择框、直接输入名称新建一个空目录并切换过去。入口与对话框在 `packages/ui/src/ChatEmptyState.tsx`（`ChatEmptyWorkspacePreviewMenu`）与 `packages/ui/src/ChatEmptyScratchWorkspaceDialog.tsx`（`ChatEmptyWorkspaceCreateDialog`）；目录创建的服务端所有者是 `IFileService.createScratchWorkspace`（`packages/services/src/file/fileService.ts`），前端不自己拼路径落盘。

本 spec 同时钉住接线：该入口曾经只把 `onCreateScratchWorkspace` 从壳层一路透传到菜单而没有渲染任何 UI，功能整块不可见；任何后续改动都不得再让这条链路悬空。

## 范围（Scope）

- 入口出现在空态 composer 的 workspace 菜单底部动作区，紧跟「打开文件夹」，文案 `workspace.startFromScratch`（从空目录开始 / Start from scratch），图标 `FolderPlus`。
- 显示条件：`allowOpenWorkspace === true` 且调用方提供了 `onCreateWorkspace`。Automations / OffPeak 等复用该菜单但 `allowOpenWorkspace={false}` 的视图不显示该入口。
- 「打开文件夹」与该入口职责分离：前者只选择已存在的目录（图标 `FolderOpen`），后者新建目录。

## 产品规则

- 创建位置固定为 `~/YCodeProject/<名称>`，由服务层 `join(homedir(), SCRATCH_WORKSPACE_ROOT_NAME, name)` 决定；UI 只提交名称，不提交路径。
- 名称校验（`getScratchWorkspaceNameErrorKind`）：trim 后为空 → `required`；含 `/` 或 `\` → `separator`；通过 → 放行。校验失败不发创建请求，行内报错。
- 落点提示（`getScratchWorkspaceLocationHint`）实时展示 `~/YCodeProject/<名称>`，与最终创建位置一致。
- 创建成功后自动 `handleSelectProject(path)` 切换当前 workspace，并关闭对话框。
- 创建失败或壳层拒绝（返回 `null`）时对话框保持打开并展示 `chat.empty.createWorkspace.error.createFailed`，不静默关闭。
- 创建请求进行中禁用确认按钮且不允许关闭对话框，避免「对话框没了、请求还在飞」。
- 每次打开重置名称草稿与错误提示：这是「新建」入口，不保留上次输入。

## 状态所有权与边界

- 目录创建唯一所有者是 `fileService.createScratchWorkspace`：`mkdir recursive`，对已存在目录幂等成功；**不初始化 git、不写模板文件**，只保证空目录存在。
- 「新建后切换到该 workspace」由根级 `handleCreateScratchWorkspace`（`packages/ui/src/root/useRootWorkspaceActions.ts`）完成，UI 不重复触发；`allowOpenWorkspace === false` 时该 handler 记录日志并返回 `null`，不做任何落盘。
- 埋点：入口动作记为 `workspace.local.lifecycle` / `create`（`packages/ui/src/lib/userActionTraceCatalog.ts`），与「打开文件夹」（不埋点）区分。
- 对话框作为 `DropdownMenuContent` 的兄弟节点渲染在 `DropdownMenu` 内（与 `SSHDialog` 同模式），不得渲染在菜单内容内部——否则选中项关闭菜单时会连同对话框一起卸载。
- 协议无新增字段：复用既有 workspace 选择链路。

## 接口

- `ChatEmptyWorkspacePreviewMenu.onCreateWorkspace?: (name: string) => Promise<string | null>`：返回创建后的 workspace 路径；壳层未开放创建能力时返回 `null`。缺省则不渲染该入口。
- 壳层接线：`WorkspaceShellLayout` 必须传 `onCreateWorkspace={onCreateScratchWorkspace}`，并让该 prop 参与 `draftComposerHeader` 的 memo 依赖。

## 验收场景

1. 空态菜单底部依次出现「打开文件夹」「从空目录开始」「远程连接」（远程能力开启时）；Automations / OffPeak 菜单不出现「从空目录开始」。
2. 名称留空或只有空白时确认：不发请求，行内提示「工作区名称不能为空。」。
3. 名称含 `/` 或 `\` 时确认：不发请求，行内提示「工作区名称不能包含 / 或 \。」。
4. 输入 `my-app` 时落点提示显示 `~/YCodeProject/my-app`；确认后目录被创建、当前 workspace 切换过去、对话框关闭。
5. 已存在同名目录时确认：创建幂等成功并切换过去，不报错、不覆盖已有内容。
6. 创建失败（如无写权限）时对话框保持打开并提示「创建工作区失败。」，名称草稿仍在。
7. 创建请求进行中取消/关闭对话框：不生效，请求继续完成。
8. 关闭再打开对话框：名称草稿与错误提示被清空。

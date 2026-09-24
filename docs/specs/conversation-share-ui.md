# Spec: 会话顶栏分享与帮助入口下线

## 目标

移除桌面会话顶栏的“分享”图标和帮助按钮，避免用户从当前工作区主动发起会话发布或打开顶栏帮助菜单；不改变已有分享链接的查看、分享导入、已导入分享的只读展示以及设置页的帮助能力。

## 现状与根因

当前桌面会话顶栏的 `WorkspaceHeaderActionSection` 在存在活动会话、用户已登录且不是 Web 时挂载 `ConversationShareMenu`。该组件渲染 `ShareIcon`，并通过 `conversationShareSelectionStore` 进入分享选择和发布流程。同一动作区在非窄屏状态下还挂载 `WorkspaceHelpMenuButton`，并由 `hideHelpMenu` 控制是否显示。

分享能力同时包含消费侧和服务侧：公开分享 URL、`zcode://share/import` 深链、导入后的只读时间线、分享服务及 RPC 描述都独立于这个顶栏入口。帮助组件还被设置页使用，因此此次只删除顶栏挂载，不删除帮助组件。

## 产品规则

- 桌面会话顶栏不再渲染会话分享按钮或帮助按钮。
- 不新增分享菜单、帮助菜单、快捷键、命令面板项或移动端发布入口作为替代。
- 设置页等非顶栏表面继续保留帮助入口。
- 已存在的分享 URL 继续支持公开查看。
- `zcode://share/import?code=...` 继续支持导入分享。
- 导入后的分享内容继续使用只读时间线展示。
- `IConversationShareService`、服务注册、RPC 描述、HTTP 客户端和已有数据格式保持不变。
- 本次不改变远控、编辑器、终端、侧栏或会话导航行为。

## 状态与边界

- 顶栏动作的唯一所有者仍是 `WorkspaceHeaderActionSection`；删除两个入口后，不新增第二个分享或帮助状态。
- 分享发布选择状态仍由 `conversationShareSelectionStore` 管理；本次不改变该状态模型或 `SessionPane` 的兼容逻辑。
- 分享消费侧的状态、导入进度、公开预览和本地只读数据分别沿用现有所有者，不迁移到顶栏组件。
- 帮助菜单的其它入口继续由设置页等现有表面管理。
- 不新增异步时序、跨窗口同步或持久化写入路径。

## 改动范围

- 新增本 spec，先确定入口下线与消费侧保留规则。
- 从 `packages/ui/src/WorkspaceHeaderSections/WorkspaceHeaderActionSection.tsx` 移除 `ConversationShareMenu` 和 `WorkspaceHelpMenuButton` 的导入与渲染。
- 删除无调用方的 `packages/ui/src/ConversationShareMenu.tsx`。
- 删除只服务于分享入口的 `conversationShare.trigger` 中英文文案。
- 删除顶栏专用的 `hideHelpMenu` 属性及 `WorkspaceHeader` 传参；保留 `WorkspaceHelpMenuButton` 组件和设置页调用。
- 不删除 `SessionPane`、分享选择组件、分享 store、分享服务、公开落地页、导入深链或只读分享组件。

## 验收场景

1. 桌面端有活动会话且用户已登录时，会话顶栏不出现分享图标、帮助图标、Tooltip 或 `conversation-share-trigger`，其它顶栏动作保持可用。
2. Web、移动远控、未登录和无活动会话状态继续不显示这两个入口，且不产生空白占位或布局塌陷。
3. 设置页仍能打开帮助菜单。
4. 打开既有 `/share/:code` 或 `/cn/share/:code` 时，公开分享页仍能加载和展示。
5. 通过 `zcode://share/import?code=...` 导入分享时，导入进度、失败重试和导入后的只读内容继续工作。
6. 引用检查确认 `ConversationShareMenu` 与 `conversationShare.trigger` 没有剩余引用，顶栏不再引用 `WorkspaceHelpMenuButton`，分享消费侧导出和协议入口仍存在。

## 验证

- `pnpm typecheck`
- `pnpm lint`
- `pnpm fmt:check`
- `pnpm architecture:check --changed`
- 手工验收桌面顶栏、设置页帮助菜单、公开分享页和分享导入流程；如环境或当前工作区已有问题阻断，记录具体结果，不将未执行项目视为通过。

/* eslint-disable max-lines -- Lexical slash 插件的 trigger/面板/键盘导航同属一个协议状态机，oxfmt 换行后略超 400 行。 */
/**
 * SlashCommandPlugin — Lexical trigger 面板插件
 *
 * 处理 `/` 面板里的 slash commands 和 subagents：
 * 1. `/` 直接展示 ZCode Agent 广播的真实 slash commands，并补充可用 subagents
 * 2. 面板通过 portal 渲染到输入区上方的独立挂载层，展开时直接覆盖消息区
 * 3. 支持 Esc 关闭、上下键切换、Enter / Tab 选中，以及跟随输入做模糊搜索
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ZCodeProvider } from "@zcode/shared";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { createPortal } from "react-dom";
import {
  $createTextNode,
  BLUR_COMMAND,
  COMMAND_PRIORITY_CRITICAL,
  COMMAND_PRIORITY_LOW,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  KEY_TAB_COMMAND,
} from "lexical";
import { useSubagents } from "@/hooks/useSubagents.js";
import { useSkills } from "@/hooks/useSkills.js";
import { buildSlashApplyMentionPayload } from "@/lib/slashApplyMentionPayload.js";
import { filterSkillsForProvider } from "@/lib/skillSourceFilter.js";
import { useZCodeIntl } from "./i18n/IntlProvider.js";
import { useSlashCommands } from "./hooks/useSlashCommands.js";
import { $createPromptMentionNode } from "./mentions/nodes/PromptMentionNode.js";
import {
  extractActivePromptInputTrigger,
  filterPromptInputSuggestions,
  getActivePromptInputTokenTailLength,
  getBestPromptInputSuggestionIndex,
  getPromptInputTriggerSignature,
  type ActivePromptInputTrigger,
  type PromptInputSuggestionItem,
} from "./lib/promptInputTriggers.js";
import { MentionPanel } from "./mentions/components/MentionPanel.js";
import {
  $isTopLevelSlashTriggerAt,
  buildAppSlashCommandSuggestions,
  buildSkillSuggestions,
  buildSubagentSuggestions,
  buildSlashSuggestions,
  filterCommandSuggestions,
  getTextAroundCursor,
  isAppSlashCommandSuggestion,
  isSlashCommandSuggestion,
  normalizeSlashCommandValue,
  type SlashCommandPluginProps,
} from "./slashCommandHelpers.js";
import { useSlashCommandMentionPanelSections } from "./slashCommandPanelSections.js";
import {
  getCurrentTextNodeSelection,
  findCommandMentionNameInEditorState,
} from "./mentions/mentionHelpers.js";
import {
  getActivePromptInputTokenReplacementRange,
  reconcileActivePromptInputTokenSnapshot,
  type ActivePromptInputTokenSnapshot,
} from "./mentions/activePromptInputToken.js";
import { shouldSlashPanelProcessUpdate } from "./lib/slashPanelUpdateFilter.js";
import { isTopLevelOnlySlashCommandName } from "./v4/slashCommands.js";

export function SlashCommandPlugin({
  workspacePath,
  workspaceIdentity,
  sessionId,
  provider,
  container,
  disabled = false,
  excludedCommandNames,
  appCommands,
  onCommandMentionChange,
}: SlashCommandPluginProps & { provider: ZCodeProvider }) {
  const [editor] = useLexicalComposerContext();
  const { intl, locale } = useZCodeIntl();
  const [activeTrigger, setActiveTrigger] = useState<ActivePromptInputTrigger | null>(null);
  // 一条输入只允许一个命令：已有命令芯片时 `/` 面板不再提供命令候选。
  // 只能在 editorState.read() 里读 Lexical 状态，所以由 update listener 采一次存进 state。
  const [hasCommandMention, setHasCommandMention] = useState(false);
  // 当前 `/` 触发符是否顶格。`/compact`、`/plan`、`/init` 只在顶格才是命令，句中不提供候选。
  const [isTopLevelTrigger, setIsTopLevelTrigger] = useState(true);
  // 命令芯片增删通知命令绑定着色；用 ref 持有回调，避免 effect 因外部回调引用变化反复注册。
  const onCommandMentionChangeRef = useRef(onCommandMentionChange);
  onCommandMentionChangeRef.current = onCommandMentionChange;
  const commandMentionNameRef = useRef<string | null>(null);
  // 远程 workspace 的 slashCommands 写在 workspaceIdentity 桶。
  // 这里只按 workspacePath 读取会落到 path 桶，表现为 ZCode Agent 已收到 available_commands_update 但 / 面板为空。
  const commands = useSlashCommands(workspacePath, workspaceIdentity);
  const {
    agents,
    loading: subagentsLoading,
    error: subagentsError,
  } = useSubagents(workspacePath, provider, workspaceIdentity);
  const {
    skills,
    loading: skillsLoading,
    error: skillsError,
  } = useSkills({
    workspacePath,
    workspaceIdentity,
    sessionId: sessionId ?? null,
    enabled: !disabled && activeTrigger?.trigger === "/",
  });
  const [selectedIndex, setSelectedIndex] = useState(0);
  const dismissedSignatureRef = useRef<string | null>(null);
  const activeSignatureRef = useRef<string | null>(null);
  const activeTokenRef = useRef<ActivePromptInputTokenSnapshot | null>(null);
  const commandSuggestions = useMemo(() => {
    const excluded = new Set((excludedCommandNames ?? []).map(normalizeSlashCommandValue));
    const cliSuggestions = buildSlashSuggestions(commands).filter(
      (item) => !excluded.has(item.value),
    );
    // App 层命令追加在 CLI catalog 之后展示；CLI 已提供同名命令时以 CLI 为准，避免遮蔽。
    const cliValues = new Set(cliSuggestions.map((item) => item.value));
    const appSuggestions = buildAppSlashCommandSuggestions(appCommands ?? []).filter(
      (item) => !cliValues.has(item.value) && !excluded.has(item.value),
    );
    return [...cliSuggestions, ...appSuggestions];
  }, [appCommands, commands, excludedCommandNames]);
  const subagentSuggestions = useMemo(() => buildSubagentSuggestions(agents), [agents]);
  const skillSuggestions = useMemo(
    () =>
      buildSkillSuggestions(
        filterSkillsForProvider(skills, provider).filter((skill) => skill.enabled),
        locale,
      ),
    [locale, provider, skills],
  );
  const filteredCommandSuggestions = useMemo(
    () =>
      filterPromptInputSuggestions(
        filterCommandSuggestions(commandSuggestions, hasCommandMention, isTopLevelTrigger),
        activeTrigger?.query ?? null,
      ),
    [commandSuggestions, activeTrigger?.query, hasCommandMention, isTopLevelTrigger],
  );
  const filteredSubagentSuggestions = useMemo(
    () => filterPromptInputSuggestions(subagentSuggestions, activeTrigger?.query ?? null),
    [subagentSuggestions, activeTrigger?.query],
  );
  const filteredSkillSuggestions = useMemo(
    () => filterPromptInputSuggestions(skillSuggestions, activeTrigger?.query ?? null),
    [skillSuggestions, activeTrigger?.query],
  );
  const filteredSuggestions = useMemo(
    () => [
      ...filteredCommandSuggestions,
      ...filteredSkillSuggestions,
      ...filteredSubagentSuggestions,
    ],
    [filteredCommandSuggestions, filteredSkillSuggestions, filteredSubagentSuggestions],
  );
  const activeSignature = useMemo(
    () => getPromptInputTriggerSignature(activeTrigger),
    [activeTrigger],
  );
  const isOpen = !disabled && activeTrigger !== null;

  useEffect(() => {
    activeSignatureRef.current = activeSignature;
  }, [activeSignature]);

  useEffect(() => {
    // 面板展示需要保留 commands/subagents 分组顺序，但键盘默认选中不能固定落在第一个分组。
    // 例如 `/rev` 时 command 描述里的弱匹配可能排在 subagent 分组前面，导致无法默认选中最佳 subagent。
    // 这里按统一的模糊评分选择全局最佳项，同时不改变面板的分组展示顺序。
    setSelectedIndex(
      getBestPromptInputSuggestionIndex(filteredSuggestions, activeTrigger?.query ?? null),
    );
  }, [activeSignature, activeTrigger?.query, filteredSuggestions]);

  useEffect(() => {
    setSelectedIndex((current) => {
      if (filteredSuggestions.length === 0) {
        return 0;
      }
      return Math.min(current, filteredSuggestions.length - 1);
    });
  }, [filteredSuggestions.length]);

  useEffect(() => {
    if (!disabled) {
      return;
    }

    setActiveTrigger(null);
    setSelectedIndex(0);
    activeTokenRef.current = null;
  }, [disabled]);

  useEffect(() => {
    return editor.registerUpdateListener(({ dirtyElements, dirtyLeaves, editorState, tags }) => {
      let nextCommandMentionName: string | null = null;
      editorState.read(() => {
        // 一条输入只允许一个命令：插入命令芯片后 `/` 面板不再提供命令候选。
        // 采样放在所有提前 return 之前，否则「关面板」的那几次更新会把状态漏掉。
        // 判定读的是整个编辑态而不只是光标前的 token——命令可以出现在句中任意位置。
        nextCommandMentionName = findCommandMentionNameInEditorState();
        setHasCommandMention((current) =>
          current === (nextCommandMentionName !== null) ? current : nextCommandMentionName !== null,
        );

        // 历史导航回填含 / 的历史条目时，不应重新打开 slash 面板，
        // 否则面板以 COMMAND_PRIORITY_CRITICAL 注册方向键处理器，吞掉后续历史翻阅按键。
        if (!shouldSlashPanelProcessUpdate(tags)) {
          activeTokenRef.current = null;
          setActiveTrigger(null);
          return;
        }

        if (disabled) {
          activeTokenRef.current = null;
          setActiveTrigger(null);
          return;
        }

        const selectionState = getCurrentTextNodeSelection();
        const cursorText = selectionState ?? getTextAroundCursor();
        if (!cursorText) {
          activeTokenRef.current = null;
          dismissedSignatureRef.current = null;
          setActiveTrigger(null);
          return;
        }

        const nextActiveToken = selectionState
          ? reconcileActivePromptInputTokenSnapshot(
              activeTokenRef.current,
              selectionState,
              dirtyElements.size === 0 && dirtyLeaves.size === 0,
            )
          : null;
        const nextActiveTrigger = selectionState
          ? nextActiveToken
          : extractActivePromptInputTrigger(cursorText.textBeforeCursor);
        if (!nextActiveTrigger || nextActiveTrigger.trigger !== "/") {
          activeTokenRef.current = null;
          dismissedSignatureRef.current = null;
          setActiveTrigger(null);
          return;
        }
        activeTokenRef.current = nextActiveToken;

        // 顶格判定与面板候选共用同一份位置事实。nodeKey 不一致说明快照已失效（用户换了
        // 段落），此时光标前缀算出来的位置才是真的。
        const topLevelTokenStart =
          selectionState && nextActiveToken?.nodeKey === selectionState.nodeKey
            ? nextActiveToken.tokenStart
            : selectionState
              ? selectionState.cursorOffset - nextActiveTrigger.query.length - 1
              : 0;
        setIsTopLevelTrigger(
          selectionState
            ? $isTopLevelSlashTriggerAt(selectionState.node, topLevelTokenStart)
            : true,
        );

        const nextSignature = getPromptInputTriggerSignature(nextActiveTrigger);
        if (
          dismissedSignatureRef.current !== null &&
          dismissedSignatureRef.current !== nextSignature
        ) {
          dismissedSignatureRef.current = null;
        }

        if (dismissedSignatureRef.current === nextSignature) {
          setActiveTrigger(null);
          return;
        }

        setActiveTrigger((current) => {
          if (
            current?.trigger === nextActiveTrigger.trigger &&
            current.query === nextActiveTrigger.query
          ) {
            return current;
          }

          return nextActiveTrigger;
        });
      });
      // 通知放在 read() 之外：接收方会写 React 草稿与 localStorage，
      // 不能嵌在 editorState.read 的只读事务里执行。
      if (commandMentionNameRef.current !== nextCommandMentionName) {
        commandMentionNameRef.current = nextCommandMentionName;
        onCommandMentionChangeRef.current?.(nextCommandMentionName);
      }
    });
  }, [disabled, editor]);

  const applySuggestion = useCallback(
    (suggestion: PromptInputSuggestionItem) => {
      const isAppCommand = isAppSlashCommandSuggestion(suggestion);
      editor.update(() => {
        // 兜底：面板状态可能落后一帧（键盘直接确认候选），插入前再核一次
        // 「本条输入还没有命令芯片」。命令之后的正文整体归为该命令参数，第二个命令
        // 插进来只会静默变成参数文本，所以这里直接不插。
        if (
          isSlashCommandSuggestion(suggestion) &&
          findCommandMentionNameInEditorState() !== null
        ) {
          return;
        }

        const selectionState = getCurrentTextNodeSelection();
        if (!selectionState) {
          return;
        }

        const snapshotRange = getActivePromptInputTokenReplacementRange(
          activeTokenRef.current,
          selectionState,
        );
        const activeSlashTrigger = snapshotRange
          ? activeTokenRef.current
          : extractActivePromptInputTrigger(selectionState.textBeforeCursor);
        if (!activeSlashTrigger || activeSlashTrigger.trigger !== "/") {
          return;
        }

        const tokenStart =
          snapshotRange?.start ?? selectionState.cursorOffset - activeSlashTrigger.query.length - 1;
        const tokenEnd =
          snapshotRange?.end ??
          selectionState.cursorOffset +
            getActivePromptInputTokenTailLength(
              activeSlashTrigger,
              selectionState.textAfterCursor,
              suggestion.value,
            );
        selectionState.selection.setTextNodeRange(
          selectionState.node,
          tokenStart,
          selectionState.node,
          tokenEnd,
        );

        if (isAppCommand) {
          // App 层命令"选中即执行"：只移除输入中的 `/xxx` token，不插入 mention、不发送。
          selectionState.selection.removeText();
          return;
        }

        // 兜底：面板状态可能落后一帧（键盘直接确认已被过滤掉的候选），顶格命令落在句中
        // 时不建芯片。芯片会让气泡把它画成命令，看起来生效了，发送端却只当普通文本。
        if (
          isTopLevelOnlySlashCommandName(suggestion.value) &&
          !$isTopLevelSlashTriggerAt(selectionState.node, tokenStart)
        ) {
          const plainTextNode = $createTextNode(`/${suggestion.value} `);
          selectionState.selection.insertNodes([plainTextNode]);
          plainTextNode.selectEnd();
          return;
        }

        const mentionNode = $createPromptMentionNode(buildSlashApplyMentionPayload(suggestion));
        const trailingWhitespace = $createTextNode(" ");
        selectionState.selection.insertNodes([mentionNode, trailingWhitespace]);
        trailingWhitespace.selectEnd();
      });

      dismissedSignatureRef.current = null;
      activeTokenRef.current = null;
      setActiveTrigger(null);
      setSelectedIndex(0);
      if (isAppCommand) {
        appCommands
          ?.find((command) => normalizeSlashCommandValue(command.value) === suggestion.value)
          ?.run();
        return;
      }
      requestAnimationFrame(() => {
        editor.focus();
      });
    },
    [appCommands, editor],
  );

  const selectSuggestion = useCallback(
    (index: number) => {
      const suggestion = filteredSuggestions[index];
      if (!suggestion) {
        return false;
      }

      applySuggestion(suggestion);
      return true;
    },
    [applySuggestion, filteredSuggestions],
  );

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const unregisterDown = editor.registerCommand(
      KEY_ARROW_DOWN_COMMAND,
      (event) => {
        if (filteredSuggestions.length === 0) {
          return false;
        }

        event?.preventDefault();
        event?.stopPropagation();
        setSelectedIndex((prev) => Math.min(prev + 1, filteredSuggestions.length - 1));
        return true;
      },
      COMMAND_PRIORITY_CRITICAL,
    );

    const unregisterUp = editor.registerCommand(
      KEY_ARROW_UP_COMMAND,
      (event) => {
        if (filteredSuggestions.length === 0) {
          return false;
        }

        event?.preventDefault();
        event?.stopPropagation();
        setSelectedIndex((prev) => Math.max(prev - 1, 0));
        return true;
      },
      COMMAND_PRIORITY_CRITICAL,
    );

    const unregisterEnter = editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event) => {
        if (!selectSuggestion(selectedIndex)) {
          return false;
        }

        event?.preventDefault();
        event?.stopPropagation();
        return true;
      },
      COMMAND_PRIORITY_CRITICAL,
    );

    const unregisterTab = editor.registerCommand(
      KEY_TAB_COMMAND,
      (event) => {
        if (!selectSuggestion(selectedIndex)) {
          return false;
        }

        event?.preventDefault();
        event?.stopPropagation();
        return true;
      },
      COMMAND_PRIORITY_CRITICAL,
    );

    const unregisterEscape = editor.registerCommand(
      KEY_ESCAPE_COMMAND,
      (event) => {
        event?.preventDefault();
        event?.stopPropagation();

        // 如果 Esc 关闭后只记 query，不区分 `/` 和 `@`，两个触发器同名查询会互相把面板压住。
        // 这里保存 trigger + query 组合签名，只有当前 token 真正变化后才重新打开，避免一关闭就立刻弹回。
        dismissedSignatureRef.current = activeSignatureRef.current;
        setActiveTrigger(null);
        setSelectedIndex(0);
        return true;
      },
      COMMAND_PRIORITY_CRITICAL,
    );

    const unregisterBlur = editor.registerCommand(
      BLUR_COMMAND,
      () => {
        dismissedSignatureRef.current = null;
        activeTokenRef.current = null;
        setActiveTrigger(null);
        setSelectedIndex(0);
        return false;
      },
      COMMAND_PRIORITY_LOW,
    );

    return () => {
      unregisterDown();
      unregisterUp();
      unregisterEnter();
      unregisterTab();
      unregisterEscape();
      unregisterBlur();
    };
  }, [editor, filteredSuggestions.length, isOpen, selectSuggestion, selectedIndex]);

  const panelTitle = intl.formatMessage({ id: "chat.slash.title" });
  const hasActiveQuery = (activeTrigger?.query ?? "").trim().length > 0;
  const panelDescription = hasActiveQuery
    ? ""
    : intl.formatMessage({ id: "chat.slash.searchHint" });

  const panelSections = useSlashCommandMentionPanelSections(
    intl,
    commands.length,
    filteredCommandSuggestions,
    filteredSkillSuggestions,
    skillsLoading,
    skillsError,
    filteredSubagentSuggestions,
    subagentsLoading,
    subagentsError,
  );

  if (!isOpen || !container) {
    return null;
  }

  return createPortal(
    <MentionPanel
      title={panelTitle}
      description={panelDescription}
      trigger="/"
      sections={panelSections}
      emptyText=""
      selectedIndex={selectedIndex}
      hasActiveQuery={hasActiveQuery}
      onSelect={selectSuggestion}
    />,
    container,
  );
}

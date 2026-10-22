import { useCallback, useEffect, useRef, useState } from "react";
import {
  WINDOW_COMMAND_BROADCAST_CHANNEL,
  windowCommandSchema,
  type WindowCommand,
  type WindowCommandBody,
} from "@zcode/shared";
import {
  CONTROLLER_WINDOW_WORKSPACES_TOPIC,
  type WindowAppearance,
  type WindowWorkspaceSetState,
} from "@zcode/shared/zcode-protocol-v4";
import { logger } from "@/logger.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useTabStoreApi } from "@/store/TabStoreProvider.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { executeWindowCommand } from "@/root/windowWorkspaceMirrorCommands.js";
import {
  createMirrorCommandLink,
  createWindowCommandAckSender,
} from "@/root/windowWorkspaceMirrorCommandLink.js";
import {
  buildWindowWorkspaceReport,
  buildWindowWorkspaceSignature,
  toMirroredWorkspaceSet,
} from "@/root/windowWorkspaceMirrorReport.js";

/**
 * 窗口工作区镜像。
 *
 * 桌面窗口是窗口结构状态的权威端，手机远控端是它的投影：
 *
 * - 权威端监听 tabStore / sessionStore 变化，把全量快照上报给 Host；
 * - 权威端执行镜像端通过广播下发的结构命令，并回执；
 * - 镜像端订阅快照并落地，同时把本地结构操作转成命令交给权威端。
 *
 * 两侧都不保留第二份可写状态：结构写操作只有一条路径，最终都在权威端执行。
 */

const REPORT_DEBOUNCE_MS = 50;

export interface WindowWorkspaceMirrorParams {
  /** 权威端=桌面窗口；镜像端=手机远控；none=不参与镜像链路。 */
  role: "authority" | "mirror" | "none";
  /** 是否启用镜像链路。 */
  enabled: boolean;
  /** 权威端执行"打开工作区"：复用窗口既有的打开流程（草稿预热、最近项目更新）。 */
  openWorkspace?: (
    workspacePath: string,
    options?: {
      workspaceIdentity?: string;
      skipCrossWindowActivation?: boolean;
    },
  ) => void | Promise<void>;
  /**
   * 深链目标：镜像端首帧要请权威端打开并激活的工作区与会话。
   *
   * 镜像端不再自行 bootstrap 工作区（那会和权威端抢写 tab 集合），
   * 深链因此改走命令通道，由权威端执行。
   */
  initialWorkspacePath?: string;
  initialWorkspaceIdentity?: string;
  initialTaskId?: string;
}

export interface WindowWorkspaceMirrorState {
  /**
   * 权威端在回执超时窗口内没有响应。
   *
   * 桌面窗口被关闭或 renderer 卡死时，镜像端不再假设命令已生效，
   * 界面必须明确告诉用户"桌面端无响应"，而不是静默地什么都不发生。
   */
  authorityUnreachable: boolean;
}

export function useWindowWorkspaceMirror(
  params: WindowWorkspaceMirrorParams,
): WindowWorkspaceMirrorState {
  const services = useBaseWorkspaceServices();
  const tabStoreApi = useTabStoreApi();
  const controller = services.windowControllerService;
  const broadcastService = services.broadcastService;
  const { role, enabled, openWorkspace } = params;
  const { initialWorkspacePath, initialWorkspaceIdentity, initialTaskId } =
    params;
  const openWorkspaceRef = useRef(openWorkspace);
  openWorkspaceRef.current = openWorkspace;

  const [authorityUnreachable, setAuthorityUnreachable] = useState(false);
  const authorityUnreachableRef = useRef(false);
  const markReachable = useCallback(() => {
    if (!authorityUnreachableRef.current) {
      return;
    }
    authorityUnreachableRef.current = false;
    setAuthorityUnreachable(false);
  }, []);
  const markUnreachable = useCallback(() => {
    if (authorityUnreachableRef.current) {
      return;
    }
    authorityUnreachableRef.current = true;
    setAuthorityUnreachable(true);
  }, []);

  // 外观状态只存在于各端 localStorage，镜像端必须从权威端取初始值，
  // 否则会出现"桌面深色、手机浅色"。
  const theme = useZCodeStore((state) => state.theme);
  const interfaceMode = useZCodeStore((state) => state.interfaceMode);
  const uiFontSizePx = useZCodeStore((state) => state.uiFontSizePx);
  const setTheme = useZCodeStore((state) => state.setTheme);
  const setInterfaceMode = useZCodeStore((state) => state.setInterfaceMode);
  const setUiFontSizePx = useZCodeStore((state) => state.setUiFontSizePx);
  // 外观放在 ref 里：值变化不应该重建镜像订阅（那会重置深链去重状态），
  // 但上报和落地都要读最新值。
  const appearanceRef = useRef<WindowAppearance>({
    theme,
    interfaceMode,
    uiFontSizePx,
  });
  appearanceRef.current = { theme, interfaceMode, uiFontSizePx };

  // clientRevision 必须跨 effect 重启保持单调：Host 只接受更大的 clientRevision，
  // 一旦回退就会被当成乱序上报丢弃，镜像端将永远收不到新的窗口结构。
  const clientRevisionRef = useRef(0);
  const lastSignatureRef = useRef<string | null>(null);
  // 权威端的上报入口：外观变化需要在不重建订阅的前提下再报一次。
  const flushRef = useRef<(() => void) | null>(null);

  // 权威端：上报窗口结构快照 + 执行镜像端下发的命令。
  useEffect(() => {
    if (role !== "authority" || !enabled || !controller) {
      return;
    }
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const flush = () => {
      timer = null;
      if (disposed) {
        return;
      }
      const candidate = buildWindowWorkspaceReport(
        tabStoreApi.getState(),
        clientRevisionRef.current + 1,
        appearanceRef.current,
      );
      const signature = buildWindowWorkspaceSignature(candidate);
      if (signature === lastSignatureRef.current) {
        return;
      }
      lastSignatureRef.current = signature;
      clientRevisionRef.current += 1;
      void controller
        .reportWindowWorkspaceSet({
          ...candidate,
          clientRevision: clientRevisionRef.current,
        })
        .catch((error) => {
          logger.warn("[windowWorkspaceMirror] 上报窗口工作区集合失败", error);
        });
    };

    const schedule = () => {
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(flush, REPORT_DEBOUNCE_MS);
    };

    // 命令串行执行：打开工作区是异步流程（要跨进程确认目录、预热草稿），
    // 并发执行会让"打开"落在"激活会话"之后，把刚激活的会话又清回草稿。
    let commandQueue: Promise<void> = Promise.resolve();
    const ackSender = createWindowCommandAckSender(broadcastService);
    // commandId 是幂等键：镜像端重试同一条命令时，权威端只执行一次。
    const processedCommandIds = new Set<string>();
    const enqueueCommand = (command: WindowCommand) => {
      if (processedCommandIds.has(command.commandId)) {
        ackSender.ack(command.commandId, true);
        return;
      }
      processedCommandIds.add(command.commandId);
      if (processedCommandIds.size > 256) {
        const oldest = processedCommandIds.values().next().value;
        if (oldest) {
          processedCommandIds.delete(oldest);
        }
      }
      commandQueue = commandQueue
        .then(async () => {
          await executeWindowCommand({
            command,
            tabStore: tabStoreApi,
            openWorkspace: (workspacePath, openOptions) =>
              openWorkspaceRef.current?.(workspacePath, openOptions),
          });
          ackSender.ack(command.commandId, true);
        })
        .catch((error) => {
          logger.warn("[windowWorkspaceMirror] 执行窗口命令失败", error);
          ackSender.ack(
            command.commandId,
            false,
            error instanceof Error ? error.message : String(error),
          );
        });
    };

    const unsubscribeTabs = tabStoreApi.subscribe(schedule);
    const unsubscribeSession = useZCodeSessionStore.subscribe(schedule);
    const disposeCommandListener = broadcastService.onMessage((message) => {
      if (message.channel !== WINDOW_COMMAND_BROADCAST_CHANNEL) {
        return;
      }
      const parsed = windowCommandSchema.safeParse(message.payload);
      if (!parsed.success) {
        logger.warn(
          "[windowWorkspaceMirror] 收到无法解析的窗口命令",
          parsed.error,
        );
        return;
      }
      enqueueCommand(parsed.data);
    });

    // 首帧先上报一次，让后加入的镜像端立刻拿到当前窗口结构。
    flushRef.current = flush;
    flush();

    return () => {
      disposed = true;
      flushRef.current = null;
      if (timer) {
        clearTimeout(timer);
      }
      unsubscribeTabs();
      unsubscribeSession();
      disposeCommandListener.dispose();
    };
  }, [broadcastService, controller, enabled, role, tabStoreApi]);

  // 外观变化也要重新上报：主题/界面模式/字号是窗口结构的一部分，
  // 镜像端要从快照里拿到权威端的当前值。
  useEffect(() => {
    if (role !== "authority" || !enabled || !controller) {
      return;
    }
    flushRef.current?.();
  }, [controller, enabled, interfaceMode, role, theme, uiFontSizePx]);

  // 镜像端：订阅窗口结构快照 + 把本地结构操作转成命令。
  useEffect(() => {
    if (role !== "mirror" || !enabled || !controller) {
      return;
    }
    let disposed = false;
    let subscriptionId: string | null = null;
    let lastRevision = -1;
    let deepLinkDispatched = false;

    const link = createMirrorCommandLink({
      broadcastService,
      onUnreachable: markUnreachable,
      onReachable: markReachable,
    });
    const dispatchCommand = (body: WindowCommandBody) => {
      link.send(body);
    };

    /**
     * 深链：请权威端打开目标工作区并激活目标会话。
     *
     * 镜像端不再自行 bootstrap 工作区，否则会和权威端各持一份 tab 集合，
     * 深链目标只能改走命令通道。目标工作区已经在权威端打开时只激活会话。
     */
    const dispatchDeepLink = (state: WindowWorkspaceSetState) => {
      if (deepLinkDispatched || !initialWorkspacePath || !initialTaskId) {
        return;
      }
      deepLinkDispatched = true;
      const opened = state.entries.some(
        (entry) =>
          entry.workspacePath === initialWorkspacePath &&
          (!initialWorkspaceIdentity ||
            entry.workspaceIdentity === initialWorkspaceIdentity),
      );
      if (opened) {
        dispatchCommand({
          type: "activate-task",
          workspacePath: initialWorkspacePath,
          ...(initialWorkspaceIdentity
            ? { workspaceIdentity: initialWorkspaceIdentity }
            : {}),
          taskId: initialTaskId,
        });
        return;
      }
      dispatchCommand({
        type: "open-workspace",
        workspacePath: initialWorkspacePath,
        ...(initialWorkspaceIdentity
          ? { workspaceIdentity: initialWorkspaceIdentity }
          : {}),
        activateTaskId: initialTaskId,
      });
    };

    /**
     * 对齐外观。
     *
     * 只在值真的不同时才写：主题、界面模式与字号在两端之间是靠广播实时同步的，
     * 这里负责的是手机端首帧的初始值。写入会落本端 localStorage 并回播一次，
     * 回播的是权威端的值，因此不会形成回环。
     */
    const applyAppearance = (next: WindowAppearance | undefined) => {
      if (!next) {
        return;
      }
      const current = appearanceRef.current;
      if (next.theme !== current.theme) {
        setTheme(next.theme);
      }
      if (next.interfaceMode !== current.interfaceMode) {
        setInterfaceMode(next.interfaceMode);
      }
      if (next.uiFontSizePx !== current.uiFontSizePx) {
        setUiFontSizePx(next.uiFontSizePx);
      }
    };

    const applyState = (state: WindowWorkspaceSetState) => {
      if (disposed || state.revision <= lastRevision) {
        return;
      }
      lastRevision = state.revision;
      markReachable();
      tabStoreApi
        .getState()
        .applyMirroredWorkspaceSet(toMirroredWorkspaceSet(state));
      const sessionStore = useZCodeSessionStore.getState();
      for (const entry of state.entries) {
        const nextTaskId = entry.activeTaskId ?? null;
        const local = sessionStore.getWorkspaceState(
          entry.workspacePath,
          entry.workspaceIdentity,
        );
        if (local.activeTaskId === nextTaskId) {
          continue;
        }
        sessionStore.applyMirroredActiveTaskId(
          entry.workspacePath,
          nextTaskId,
          entry.workspaceIdentity,
        );
      }
      applyAppearance(state.appearance);
      dispatchDeepLink(state);
    };

    const frameDisposable = controller.onDynamicControllerFrame()((frame) => {
      if (frame.topic !== CONTROLLER_WINDOW_WORKSPACES_TOPIC) {
        return;
      }
      if (frame.payload.kind === "snapshot") {
        applyState(frame.payload.snapshot.windowWorkspaces);
        return;
      }
      for (const delta of frame.payload.deltas) {
        if (delta.op === "window-workspaces.replaced") {
          applyState(delta.windowWorkspaces);
        }
      }
    });

    void controller
      .subscribeControllerV4({ topic: CONTROLLER_WINDOW_WORKSPACES_TOPIC })
      .then((result) => {
        subscriptionId = result.ack.subscriptionId;
      })
      .catch((error) => {
        logger.error("[windowWorkspaceMirror] 订阅窗口工作区集合失败", error);
      });

    tabStoreApi.getState().setCommandSink({
      openWorkspace: (workspacePath, options) => {
        dispatchCommand({
          type: "open-workspace",
          workspacePath,
          ...(options?.workspaceIdentity
            ? { workspaceIdentity: options.workspaceIdentity }
            : {}),
        });
      },
      ensureWorkspace: (workspacePath, options) => {
        dispatchCommand({
          type: "ensure-workspace",
          workspacePath,
          ...(options?.workspaceIdentity
            ? { workspaceIdentity: options.workspaceIdentity }
            : {}),
        });
      },
      closeWorkspace: (tabId) => {
        dispatchCommand({ type: "close-workspace", entryId: tabId });
      },
      activateWorkspace: (tabId) => {
        dispatchCommand({ type: "activate-workspace", entryId: tabId });
      },
      reorderWorkspaces: (fromIndex, toIndex) => {
        dispatchCommand({ type: "reorder-workspaces", fromIndex, toIndex });
      },
      setWorkspaceExpanded: (workspacePath, expanded) => {
        dispatchCommand({
          type: "set-workspace-expanded",
          workspacePath,
          expanded,
        });
      },
    });
    useZCodeSessionStore.getState().setActiveTaskCommandSink({
      activateTask: (workspacePath, id, workspaceIdentity) => {
        dispatchCommand({
          type: "activate-task",
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          taskId: id,
        });
      },
    });

    return () => {
      disposed = true;
      tabStoreApi.getState().setCommandSink(null);
      useZCodeSessionStore.getState().setActiveTaskCommandSink(null);
      frameDisposable.dispose();
      link.dispose();
      if (subscriptionId) {
        void controller
          .unsubscribeControllerV4({ subscriptionId })
          .catch(() => {});
      }
    };
  }, [
    broadcastService,
    controller,
    enabled,
    initialTaskId,
    initialWorkspaceIdentity,
    initialWorkspacePath,
    markReachable,
    markUnreachable,
    role,
    setInterfaceMode,
    setTheme,
    setUiFontSizePx,
    tabStoreApi,
  ]);

  return { authorityUnreachable };
}

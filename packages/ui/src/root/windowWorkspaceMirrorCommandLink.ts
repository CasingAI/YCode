import {
  createUuid,
  WINDOW_COMMAND_ACK_BROADCAST_CHANNEL,
  WINDOW_COMMAND_BROADCAST_CHANNEL,
  windowCommandAckSchema,
  type WindowCommand,
  type WindowCommandBody,
} from "@zcode/shared";
import type { IBroadcastService } from "@zcode/services";
import { logger } from "@/logger.js";

/**
 * 镜像端与权威端之间的命令链路。
 *
 * 命令走广播是单向直达的：镜像端发出后只能等权威端回传新快照才能确认。
 * 但"有没有新快照"不能当成确认信号——切换到已经激活的会话这类无副作用命令
 * 不会改变窗口结构，也就不会有新快照，用它判断会误报"桌面端无响应"。
 *
 * 因此权威端执行完命令后回一条回执（独立 channel，避免被当成新命令再执行一次），
 * 镜像端按回执判断桌面端是否还活着：超时即进入只读态，不再发新命令。
 */
export interface MirrorCommandLink {
  /** 发送一条结构命令，并登记等待回执。 */
  send: (body: WindowCommandBody) => void;
  /** 释放监听与定时器。 */
  dispose: () => void;
}

/** 回执超时窗口。桌面端卡死时手机端必须在可感知的时限内停下，而不是一直空转。 */
export const WINDOW_COMMAND_ACK_TIMEOUT_MS = 5000;

export function createMirrorCommandLink(options: {
  broadcastService: IBroadcastService;
  timeoutMs?: number;
  /** 权威端超时未回执：镜像端进入只读态。 */
  onUnreachable: () => void;
  /** 收到回执：镜像端恢复可写。 */
  onReachable: () => void;
}): MirrorCommandLink {
  const timeoutMs = options.timeoutMs ?? WINDOW_COMMAND_ACK_TIMEOUT_MS;
  const pending = new Map<string, ReturnType<typeof setTimeout>>();

  const clearPending = (commandId: string) => {
    const timer = pending.get(commandId);
    if (timer) {
      clearTimeout(timer);
      pending.delete(commandId);
    }
  };

  const disposeAckListener = options.broadcastService.onMessage((message) => {
    if (message.channel !== WINDOW_COMMAND_ACK_BROADCAST_CHANNEL) {
      return;
    }
    const parsed = windowCommandAckSchema.safeParse(message.payload);
    if (!parsed.success) {
      return;
    }
    if (!pending.has(parsed.data.commandId)) {
      // 不是本端等待中的命令（例如另一台手机端的回执）：忽略。
      return;
    }
    clearPending(parsed.data.commandId);
    options.onReachable();
  });

  return {
    send(body: WindowCommandBody) {
      const command: WindowCommand = { ...body, commandId: createUuid() };
      clearPending(command.commandId);
      const timer = setTimeout(() => {
        pending.delete(command.commandId);
        logger.warn("[windowWorkspaceMirror] 命令回执超时，桌面端可能已断开");
        options.onUnreachable();
      }, timeoutMs);
      pending.set(command.commandId, timer);
      void options.broadcastService
        .send({ channel: WINDOW_COMMAND_BROADCAST_CHANNEL, payload: command })
        .catch((error) => {
          clearPending(command.commandId);
          logger.warn("[windowWorkspaceMirror] 发送窗口命令失败", error);
          options.onUnreachable();
        });
    },
    dispose() {
      for (const timer of pending.values()) {
        clearTimeout(timer);
      }
      pending.clear();
      disposeAckListener.dispose();
    },
  };
}

/**
 * 权威端的回执发送器。
 *
 * 每条命令执行完都要回执：成功与否都要回，否则镜像端会一直等到超时，
 * 把"命令被拒绝"误报成"桌面端无响应"。
 */
export function createWindowCommandAckSender(broadcastService: IBroadcastService): {
  ack: (commandId: string, ok: boolean, error?: string) => void;
} {
  return {
    ack(commandId, ok, error) {
      void broadcastService
        .send({
          channel: WINDOW_COMMAND_ACK_BROADCAST_CHANNEL,
          payload: { commandId, ok, ...(error ? { error } : {}) },
        })
        .catch((sendError) => {
          logger.warn("[windowWorkspaceMirror] 发送命令回执失败", sendError);
        });
    },
  };
}

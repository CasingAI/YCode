/**
 * 内置浏览器 guest renderer 的 CPU 调度优先级收口（spec: docs/specs/process-priority.md）。
 *
 * 约束：
 * - 只降低、不提高：复用 `@zcode/shared/process-priority`，重复应用返回 unchanged。
 * - 只有已登记并绑定的 `<webview>` guest 才降级；与主 UI renderer/Main 共享 PID 时必须跳过，
 *   否则会连带降低主界面。
 * - 跨源导航会换 renderer 进程，旧 PID 失效；因此在主 frame 导航提交、dom-ready、加载完成
 *   后重新读取 `getOSProcessId()` 并重应用。OOPIF 子 frame 不在覆盖范围。
 * - 不维护 PID 表、不轮询；生命周期跟随 guest 绑定。
 */

import { lowerProcessPriority } from "@zcode/shared/process-priority";

export interface GuestRendererPriorityTarget {
  getType?(): string;
  getOSProcessId?(): number;
  on?(event: string, listener: () => void): void;
  removeListener?(event: string, listener: () => void): void;
}

export type GuestRendererPriorityLower = (pid: number, priority: "idle") => unknown;

/** 主 frame 导航提交、DOM 就绪、加载完成都会重新读取 PID；渲染进程重建后由后两者兜底。 */
export const GUEST_RENDERER_PRIORITY_EVENTS = [
  "did-navigate",
  "dom-ready",
  "did-finish-load",
] as const;

export interface GuestRendererPriorityOptions {
  guest: GuestRendererPriorityTarget;
  /** 与主 UI renderer / Main 共享的 PID 必须保护，不得降级。 */
  isProtectedPid?: (pid: number) => boolean;
  lower?: GuestRendererPriorityLower;
}

export interface GuestRendererPriorityHandle {
  /** 幂等；只降不升。 */
  sync(): void;
  dispose(): void;
}

export function installGuestRendererPriority(
  options: GuestRendererPriorityOptions,
): GuestRendererPriorityHandle {
  const { guest } = options;
  const lower = options.lower ?? lowerProcessPriority;
  const isProtectedPid = options.isProtectedPid;
  const listeners: Array<{ event: string; listener: () => void }> = [];
  let disposed = false;

  const sync = (): void => {
    if (disposed) return;
    try {
      if (typeof guest.getType === "function" && guest.getType() !== "webview") return;
      if (typeof guest.getOSProcessId !== "function") return;
      const pid = guest.getOSProcessId();
      if (!Number.isInteger(pid) || pid <= 0) return;
      if (isProtectedPid?.(pid)) return;
      lower(pid, "idle");
    } catch {
      // 优先级只是尽力策略：guest 已销毁或读取失败不能影响页面生命周期。
    }
  };

  if (typeof guest.on === "function" && typeof guest.removeListener === "function") {
    for (const event of GUEST_RENDERER_PRIORITY_EVENTS) {
      const listener = () => sync();
      try {
        guest.on(event, listener);
        listeners.push({ event, listener });
      } catch {
        // 已销毁的 guest 注册监听会抛 "Object has been destroyed"；跳过即可。
      }
    }
  }

  return {
    sync,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const { event, listener } of listeners.splice(0)) {
        try {
          guest.removeListener?.(event, listener);
        } catch {
          // guest 销毁后 removeListener 可能抛错，不影响其它生命周期收口。
        }
      }
    },
  };
}

// 窄视口下「大幅右滑打开侧栏」手势的事件接线。
//
// 判定逻辑在 workspaceShellSwipeGesture.ts（纯函数，不读 DOM），这里是唯一
// 读 DOM 的地方：把触摸事件翻译成那几条判定。产品规则见
// docs/specs/workspace-shell-swipe-gesture.md。
//
// 关键约束：全程 passive、从不 preventDefault。竖向滚动是浏览器的地盘，
// 本手势只在「起手点不在任何会横向滚动的容器里」时观察，一旦判定不该管
// 就整个作废，绝不与原生滚动抢事件。

import { useEffect, useRef, type RefObject } from "react";
import {
  advanceSwipeGesture,
  createSwipeGestureState,
  isHorizontallyScrollableContainer,
  type SwipeGestureState,
} from "@/app-shell/workspaceShellSwipeGesture.js";

/**
 * 手势让位：起手点落在这些区域里，整个触摸序列作废。
 *
 * 逐个列出来而不是「默认允许」：这些区域的语义都比导航更具体，输入区是打字、
 * 终端是终端、Side Pane 是另一个模态层。侧栏自身在收起态是 pointer-events-none，
 * 本来就收不到触摸，留着只是兜底。
 */
export const WORKSPACE_SWIPE_BLOCKED_SELECTOR = [
  '[data-workspace-sidebar-panel="true"]',
  '[data-v4-composer-dock="true"]',
  '[data-workspace-terminal-frame="true"]',
  '[data-workspace-side-pane-wrapper="true"]',
].join(",");

interface SwipeSession {
  /** 触点标识：多指时只跟第一根手指，第二根落下不能把起点换掉。 */
  identifier: number;
  startX: number;
  startY: number;
  state: SwipeGestureState;
}

export interface UseWorkspaceSidebarSwipeOptions {
  /** 手势宿主：工作区外壳根元素。 */
  shellElementRef: RefObject<HTMLElement | null>;
  /** 是否启用手势。抽屉形态且侧栏收起时才为真。 */
  isEnabled: boolean;
  /** 达到阈值后的动作：把侧栏置为可见。 */
  onOpenSidebar: () => void;
}

/**
 * 起手点是否落在不该抢手势的地方：明确排除的区域，或可横向滚动且内容确实超宽的容器。
 *
 * 必须用 composedPath 而不是 closest：代码块的滚动容器在 @pierre/diffs 的
 * Shadow DOM 里，事件在 shadow 树外会被重定向到宿主，closest 看不见内部节点。
 */
function isSwipeBlockedByPath(event: TouchEvent): boolean {
  for (const node of event.composedPath()) {
    if (!(node instanceof Element)) {
      continue;
    }
    if (node.matches(WORKSPACE_SWIPE_BLOCKED_SELECTOR)) {
      return true;
    }
    // 先读尺寸再读样式：尺寸相等就跳过，避免对整条路径逐个取 computed style。
    if (node.scrollWidth - node.clientWidth <= 1) {
      continue;
    }
    if (
      isHorizontallyScrollableContainer({
        scrollWidth: node.scrollWidth,
        clientWidth: node.clientWidth,
        overflowX: window.getComputedStyle(node).overflowX,
      })
    ) {
      return true;
    }
  }
  return false;
}

export function useWorkspaceSidebarSwipe(
  options: UseWorkspaceSidebarSwipeOptions,
): void {
  const { shellElementRef, isEnabled, onOpenSidebar } = options;
  const sessionRef = useRef<SwipeSession | null>(null);
  const onOpenSidebarRef = useRef(onOpenSidebar);
  onOpenSidebarRef.current = onOpenSidebar;

  useEffect(() => {
    const shellElement = shellElementRef.current;
    if (!shellElement || !isEnabled) {
      return;
    }

    const handleTouchStart = (event: TouchEvent) => {
      const touch = event.changedTouches[0];
      if (!touch) {
        sessionRef.current = null;
        return;
      }
      const state = createSwipeGestureState();
      sessionRef.current = {
        identifier: touch.identifier,
        startX: touch.clientX,
        startY: touch.clientY,
        state: isSwipeBlockedByPath(event)
          ? { ...state, abandoned: true }
          : state,
      };
    };

    const handleTouchMove = (event: TouchEvent) => {
      const session = sessionRef.current;
      if (!session) {
        return;
      }
      const touch = Array.from(event.touches).find(
        (candidate) => candidate.identifier === session.identifier,
      );
      if (!touch) {
        return;
      }
      session.state = advanceSwipeGesture({
        state: session.state,
        deltaX: touch.clientX - session.startX,
        deltaY: touch.clientY - session.startY,
        viewportWidthPx: window.innerWidth,
      });
    };

    const handleTouchEnd = () => {
      const session = sessionRef.current;
      sessionRef.current = null;
      if (session?.state.pendingOpen) {
        onOpenSidebarRef.current();
      }
    };

    // 取消（浏览器接管了这次触摸，例如系统边缘手势）不算完成：
    // 直接丢弃序列，不提交打开。
    const handleTouchCancel = () => {
      sessionRef.current = null;
    };

    shellElement.addEventListener("touchstart", handleTouchStart, { passive: true });
    shellElement.addEventListener("touchmove", handleTouchMove, { passive: true });
    shellElement.addEventListener("touchend", handleTouchEnd, { passive: true });
    shellElement.addEventListener("touchcancel", handleTouchCancel, { passive: true });
    return () => {
      // 退订时清掉进行中的序列：手势可能在侧栏被其他方式打开后失效，
      // 留着半截序列会让下一次触摸的 move 接到旧起点上。
      sessionRef.current = null;
      shellElement.removeEventListener("touchstart", handleTouchStart);
      shellElement.removeEventListener("touchmove", handleTouchMove);
      shellElement.removeEventListener("touchend", handleTouchEnd);
      shellElement.removeEventListener("touchcancel", handleTouchCancel);
    };
  }, [shellElementRef, isEnabled]);
}

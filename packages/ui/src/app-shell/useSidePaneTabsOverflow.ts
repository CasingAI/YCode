import { useEffect, useRef, useState, type RefObject } from "react";
import {
  EMPTY_SIDE_PANE_TABS_MASK_EDGES,
  resolveSidePaneTabsMaskEdges,
  resolveSidePaneTabsOverflow,
  type SidePaneTabsMaskEdges,
} from "@/app-shell/sidePaneLayout.js";

const DEFAULT_ADD_TAB_TRIGGER_SELECTOR = "[data-side-pane-add-tab-trigger]";

export interface UseSidePaneTabsOverflowOptions {
  viewportRef: RefObject<HTMLElement | null>;
  contentRef: RefObject<HTMLElement | null>;
  /**
   * 最新标签数量；回调通过 ref 读取，不会固定住绑定时的旧值。
   * 省略时回退到 `visibleTabs.length`，方便只有列表来源的调用方直接复用。
   */
  tabCount?: number;
  /**
   * 标签数组只作为“几何失效信号”：成员、标题或重排改变时传入新值即可。
   * 不得为它拆装 ResizeObserver；observer 只跟随真实 DOM 节点与 enabled。
   * 调用方应 memo 化该数组，否则每次渲染都会排一次几何重测（有界但无意义）。
   */
  visibleTabs: readonly unknown[];
  /** owner / workspace / 语言等数组语义之外的失效键。 */
  invalidationKey?: string | number | boolean | null;
  /** 面板是否具备可测 DOM（首次打开后为 true）。 */
  enabled?: boolean;
  /** 新增按钮选择器；与组件现有 DOM 标记一致。 */
  addButtonSelector?: string;
}

export interface UseSidePaneTabsOverflowResult {
  isOverflowing: boolean;
  maskEdges: SidePaneTabsMaskEdges;
}

type BoundStatus = "none" | "bound" | "existing";

type SidePaneTabsBinding = {
  viewport: HTMLElement;
  content: HTMLElement;
  addButton: HTMLElement | null;
  observer: ResizeObserver | null;
  scrollHandler: () => void;
  resizeHandler: () => void;
};

type LatestInputs = {
  tabCount: number;
  enabled: boolean;
  addButtonSelector: string;
};

/**
 * 侧栏 tabs 溢出与两端 mask 的局部几何缓存。
 *
 * 职责边界：
 * - 几何脏（ResizeObserver / window resize / 标签成员、标题、语言、owner、显隐变化）时集中读取
 *   viewport / content / 新增按钮，并在同一 rAF 槽内只做一次测量。
 * - 普通 scroll 只读 scrollLeft 并复用已测得的 maxScrollLeft，不再读 scrollWidth / clientWidth
 *   或新增按钮矩形。
 * - 零宽（未布局、display:none、面板收起）时不依据不可测尺寸移动 overflow 按钮；恢复可见后由
 *   真实 ResizeObserver 重新失效几何。
 * - overflow 改变新增按钮 DOM 位置后，等 React 提交完成再通过显式失效与真实 ResizeObserver
 *   进入下一轮测量，不在 setState 后立即读取尚未提交的布局。
 */
export function useSidePaneTabsOverflow({
  viewportRef,
  contentRef,
  tabCount: tabCountProp,
  visibleTabs,
  invalidationKey,
  enabled = true,
  addButtonSelector = DEFAULT_ADD_TAB_TRIGGER_SELECTOR,
}: UseSidePaneTabsOverflowOptions): UseSidePaneTabsOverflowResult {
  const tabCount = tabCountProp ?? visibleTabs.length;
  const [isOverflowing, setIsOverflowing] = useState(false);
  const [maskEdges, setMaskEdges] = useState<SidePaneTabsMaskEdges>(
    EMPTY_SIDE_PANE_TABS_MASK_EDGES,
  );

  const latestInputsRef = useRef<LatestInputs>({
    tabCount,
    enabled,
    addButtonSelector,
  });
  const overflowingRef = useRef(false);
  const maskEdgesRef = useRef<SidePaneTabsMaskEdges>(EMPTY_SIDE_PANE_TABS_MASK_EDGES);
  const bindingRef = useRef<SidePaneTabsBinding | null>(null);
  const frameRef = useRef<number | null>(null);
  const geometryDirtyRef = useRef(true);
  const positionDirtyRef = useRef(false);
  const maxScrollLeftRef = useRef<number | null>(null);
  const previousOverflowRef = useRef(false);
  const semanticEpochMountedRef = useRef(false);

  const updateOverflow = (next: boolean) => {
    if (overflowingRef.current === next) return;
    overflowingRef.current = next;
    setIsOverflowing(next);
  };

  const updateMask = (
    scrollLeft: number,
    maxScrollLeft: number,
    overflowing = overflowingRef.current,
  ) => {
    const next = resolveSidePaneTabsMaskEdges({
      isOverflowing: overflowing,
      scrollLeft,
      maxScrollLeft,
    });
    const current = maskEdgesRef.current;
    if (current.left === next.left && current.right === next.right) return;
    maskEdgesRef.current = next;
    setMaskEdges(next);
  };

  const findAddButton = (viewport: HTMLElement) =>
    viewport.parentElement?.querySelector<HTMLElement>(latestInputsRef.current.addButtonSelector) ??
    null;

  const syncObservedAddButton = (binding: SidePaneTabsBinding) => {
    // overflow 翻转会让新增按钮在内容末尾与右侧栏之间换位（React 重建该节点）。
    // 这里只换绑按钮节点，不 disconnect viewport / content，避免标签增删把整组观察拆掉重装。
    const addButton = findAddButton(binding.viewport);
    if (binding.addButton === addButton) return;
    if (binding.addButton) binding.observer?.unobserve(binding.addButton);
    if (addButton) binding.observer?.observe(addButton);
    binding.addButton = addButton;
  };

  const cancelFrame = () => {
    if (frameRef.current === null) return;
    if (typeof window !== "undefined" && typeof window.cancelAnimationFrame === "function") {
      window.cancelAnimationFrame(frameRef.current);
    }
    frameRef.current = null;
  };

  const measureGeometry = () => {
    const binding = bindingRef.current;
    if (!binding) return;
    syncObservedAddButton(binding);

    const viewportWidth = binding.viewport.clientWidth;
    if (!(viewportWidth > 0)) {
      // 零宽无法测量：保持当前 overflow 按钮位置与 mask，等真实尺寸通知恢复后再测。
      geometryDirtyRef.current = false;
      positionDirtyRef.current = false;
      maxScrollLeftRef.current = null;
      return;
    }

    const maxScrollLeft = Math.max(0, binding.viewport.scrollWidth - viewportWidth);
    const addButtonWidth = binding.addButton?.getBoundingClientRect().width ?? 0;
    const addButtonInside = Boolean(
      binding.addButton && binding.content.contains(binding.addButton),
    );
    // 继续沿用 60px 最小宽度预算与 1px 容差；不改为实测 scrollWidth，避免 overflow
    // 移动按钮后再次改变宽度形成反馈环。
    const nextOverflowing = resolveSidePaneTabsOverflow({
      addButtonInside,
      addButtonWidth,
      tabCount: latestInputsRef.current.tabCount,
      viewportWidth,
    });

    geometryDirtyRef.current = false;
    positionDirtyRef.current = false;
    maxScrollLeftRef.current = maxScrollLeft;
    updateOverflow(nextOverflowing);
    updateMask(binding.viewport.scrollLeft, maxScrollLeft, nextOverflowing);
  };

  const flush = () => {
    frameRef.current = null;
    const status = ensureBound();
    if (status === "none" || status === "bound") {
      // bind 已在同一帧同步完成首轮测量，不再重复读取布局。
      return;
    }
    if (geometryDirtyRef.current || maxScrollLeftRef.current === null) {
      measureGeometry();
      return;
    }
    if (!positionDirtyRef.current) return;
    positionDirtyRef.current = false;
    const binding = bindingRef.current;
    const maxScrollLeft = maxScrollLeftRef.current;
    if (!binding || maxScrollLeft === null) return;
    // scroll 热路径：只读 scrollLeft，复用有效几何缓存。
    updateMask(binding.viewport.scrollLeft, maxScrollLeft);
  };

  const scheduleFrame = () => {
    if (frameRef.current !== null) return;
    if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
      flush();
      return;
    }
    frameRef.current = window.requestAnimationFrame(flush);
  };

  const markGeometryDirty = () => {
    geometryDirtyRef.current = true;
    scheduleFrame();
  };

  const disposeBinding = (resetState: boolean) => {
    const binding = bindingRef.current;
    bindingRef.current = null;
    if (binding) {
      binding.observer?.disconnect();
      binding.viewport.removeEventListener("scroll", binding.scrollHandler);
      if (typeof window !== "undefined") {
        window.removeEventListener("resize", binding.resizeHandler);
      }
    }
    cancelFrame();
    geometryDirtyRef.current = true;
    positionDirtyRef.current = false;
    maxScrollLeftRef.current = null;
    if (resetState) {
      updateOverflow(false);
      updateMask(0, 0, false);
    }
  };

  const bind = (viewport: HTMLElement, content: HTMLElement) => {
    const scrollHandler = () => {
      positionDirtyRef.current = true;
      scheduleFrame();
    };
    const resizeHandler = () => {
      markGeometryDirty();
    };
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            markGeometryDirty();
          });
    observer?.observe(viewport);
    observer?.observe(content);
    const addButton = findAddButton(viewport);
    if (addButton) observer?.observe(addButton);

    bindingRef.current = {
      viewport,
      content,
      addButton,
      observer,
      scrollHandler,
      resizeHandler,
    };
    viewport.addEventListener("scroll", scrollHandler, { passive: true });
    if (typeof window !== "undefined") {
      window.addEventListener("resize", resizeHandler);
    }

    geometryDirtyRef.current = true;
    // 保留既有初始检测时序：节点就绪后立即同步测一次，而不是等下一帧。
    measureGeometry();
  };

  function ensureBound(): BoundStatus {
    const inputs = latestInputsRef.current;
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!inputs.enabled || !viewport || !content) {
      if (bindingRef.current) disposeBinding(true);
      return "none";
    }
    const binding = bindingRef.current;
    if (binding && binding.viewport === viewport && binding.content === content) {
      // overflow 翻转会让新增按钮换到另一个容器（React 重建节点）。这里只做 O(1) 的
      // isConnected 检查：真正的换绑由下一轮几何测量完成，避免每次渲染都查询 DOM。
      if (binding.addButton && !binding.addButton.isConnected) {
        markGeometryDirty();
      }
      return "existing";
    }
    disposeBinding(false);
    bind(viewport, content);
    return "bound";
  }

  // 最新输入必须先于其它 effect 生效，回调里读取的永远是本次渲染的值。
  useEffect(() => {
    latestInputsRef.current = { tabCount, enabled, addButtonSelector };
    // 节点身份只能在提交后读取：首次挂载、enabled 翻转、或父级用新节点替换 Tabs 时在这里换绑。
    // 节点未变时只是引用比较，不触碰 observer；这比把 visibleTabs 放进依赖更稳，
    // 因为标签对象身份变化不应拆装观察。
    ensureBound();
  });

  // 卸载时断开观察并取消待执行帧。
  useEffect(() => () => disposeBinding(false), []);

  // 语义变化（成员 / 标题 / 语言 / owner / enabled）只失效几何，不重绑 observer。
  useEffect(() => {
    if (!semanticEpochMountedRef.current) {
      semanticEpochMountedRef.current = true;
      return;
    }
    markGeometryDirty();
  }, [visibleTabs, tabCount, invalidationKey, enabled]);

  // overflow 改变新增按钮位置后，React 已提交新 DOM；这里只标脏并排入 rAF，
  // 由下一轮测量读取已提交布局，避免紧跟 setState 读取旧布局。
  useEffect(() => {
    if (previousOverflowRef.current === isOverflowing) return;
    previousOverflowRef.current = isOverflowing;
    markGeometryDirty();
  }, [isOverflowing]);

  return { isOverflowing, maskEdges };
}

import { useLayoutEffect, useRef } from "react";

/** 仅拥有 DOM 布局投影；权限、Plan 和 CUA 业务状态仍由原有 hooks 管理。 */
const OBSERVED_TOOLBAR_SELECTOR =
  "[data-composer-leading-actions], [data-composer-leading-content], [data-composer-trailing-actions]";
const COLLAPSE_CONTROL_SELECTOR = "[data-composer-collapse-priority]";

function fitComposerToolbar(root: HTMLElement) {
  const available = root.querySelector<HTMLElement>("[data-composer-leading-actions]");
  const content = root.querySelector<HTMLElement>("[data-composer-leading-content]");
  if (!available || !content) return;
  const controls = Array.from(root.querySelectorAll<HTMLElement>(COLLAPSE_CONTROL_SELECTOR)).sort(
    (a, b) =>
      Number(a.dataset.composerCollapsePriority) - Number(b.dataset.composerCollapsePriority),
  );
  if (!controls.length) return;
  // 每次从完整布局测量，避免各按钮独立 observer 互相抢空间，也覆盖语言与异步入口变化。
  delete root.dataset.composerModelIcon;
  root.style.removeProperty("--composer-model-max-width");
  delete root.dataset.composerProviderCompact;
  for (const control of controls) delete control.dataset.composerCompact;
  const prefixLine = root.querySelector<HTMLElement>(".composer-provider-prefix")?.parentElement;
  if (prefixLine && prefixLine.scrollWidth > prefixLine.clientWidth) {
    root.dataset.composerProviderCompact = "true";
  }
  const fits = () =>
    content.getBoundingClientRect().width <= available.getBoundingClientRect().width;
  for (const control of controls) {
    if (fits()) return;
    control.dataset.composerCompact = "true";
    if (control.dataset.composerCollapsePriority === "0" && !fits()) {
      root.dataset.composerProviderCompact = "true";
    }
  }
  if (!fits()) {
    const model = root.querySelector<HTMLElement>(".composer-model-trigger");
    if (!model) return;
    const trailing = root.querySelector<HTMLElement>("[data-composer-trailing-actions]");
    const gap = Number.parseFloat(getComputedStyle(root).columnGap) || 12;
    const overflow = Math.max(
      content.getBoundingClientRect().width - available.getBoundingClientRect().width,
      trailing
        ? content.getBoundingClientRect().width +
            trailing.getBoundingClientRect().width +
            gap -
            root.getBoundingClientRect().width
        : 0,
    );
    const modelWidth = Math.max(28, model.getBoundingClientRect().width - overflow);
    // 收起左侧文案后，剩余空间必须让给同一行的模型与发送按钮，不能靠换行掩盖溢出。
    if (modelWidth < 80) root.dataset.composerModelIcon = "true";
    else root.style.setProperty("--composer-model-max-width", `${modelWidth}px`);
  }
}

function setBooleanDataAttribute(element: HTMLElement, key: string, value: boolean) {
  if (value) {
    if (element.dataset[key] !== "true") element.dataset[key] = "true";
    return;
  }
  if (element.dataset[key] !== undefined) delete element.dataset[key];
}

/**
 * 只把探针测得的最终投影同步到真实节点；值未变化时零写入，避免触发
 * ResizeObserver 回流的无效属性写。
 */
function applyToolbarProjection(root: HTMLElement, probe: HTMLElement) {
  setBooleanDataAttribute(root, "composerModelIcon", probe.dataset.composerModelIcon === "true");
  setBooleanDataAttribute(
    root,
    "composerProviderCompact",
    probe.dataset.composerProviderCompact === "true",
  );
  const probeModelMaxWidth = probe.style.getPropertyValue("--composer-model-max-width");
  const liveModelMaxWidth = root.style.getPropertyValue("--composer-model-max-width");
  if (probeModelMaxWidth !== liveModelMaxWidth) {
    if (probeModelMaxWidth)
      root.style.setProperty("--composer-model-max-width", probeModelMaxWidth);
    else root.style.removeProperty("--composer-model-max-width");
  }
  const liveControls = Array.from(root.querySelectorAll<HTMLElement>(COLLAPSE_CONTROL_SELECTOR));
  const measuredControls = Array.from(
    probe.querySelectorAll<HTMLElement>(COLLAPSE_CONTROL_SELECTOR),
  );
  liveControls.forEach((control, index) => {
    setBooleanDataAttribute(
      control,
      "composerCompact",
      measuredControls[index]?.dataset.composerCompact === "true",
    );
  });
}

function collectObservedElements(root: HTMLElement): Set<HTMLElement> {
  const elements = new Set<HTMLElement>([root]);
  for (const element of root.querySelectorAll<HTMLElement>(OBSERVED_TOOLBAR_SELECTOR)) {
    elements.add(element);
  }
  return elements;
}

function isSameElementSet(current: Set<HTMLElement>, next: Set<HTMLElement>): boolean {
  if (current.size !== next.size) return false;
  for (const element of next) {
    if (!current.has(element)) return false;
  }
  return true;
}

export function useComposerToolbarFit() {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;

    let observedElements = new Set<HTMLElement>();
    let rafId: number | null = null;
    let observationsDirty = false;
    let disposed = false;

    const syncObservedElements = () => {
      if (!resize) return;
      const next = collectObservedElements(root);
      if (isSameElementSet(observedElements, next)) return;
      resize.disconnect();
      for (const element of next) resize.observe(element);
      observedElements = next;
    };

    const update = () => {
      if (disposed || !root.isConnected || !root.parentElement) return;
      const rootWidth = root.getBoundingClientRect().width;
      if (rootWidth <= 0) return;
      // 在不可见副本上尝试展开，避免真实按钮测量时来回移动、丢失 hover 或关闭 Tooltip。
      const probe = root.cloneNode(true) as HTMLElement;
      probe.setAttribute("aria-hidden", "true");
      probe.inert = true;
      Object.assign(probe.style, {
        position: "absolute",
        visibility: "hidden",
        pointerEvents: "none",
        width: `${rootWidth}px`,
        left: "0",
        top: "0",
      });
      root.parentElement.append(probe);
      try {
        fitComposerToolbar(probe);
        applyToolbarProjection(root, probe);
      } finally {
        probe.remove();
      }
    };

    const runScheduledUpdate = () => {
      rafId = null;
      if (disposed) return;
      if (observationsDirty) {
        observationsDirty = false;
        syncObservedElements();
      }
      update();
    };

    const requestUpdate = (refreshObservations = false) => {
      if (disposed) return;
      if (refreshObservations) observationsDirty = true;
      if (rafId !== null) return;
      if (typeof requestAnimationFrame === "undefined") {
        runScheduledUpdate();
        return;
      }
      rafId = requestAnimationFrame(runScheduledUpdate);
    };

    const resize =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => requestUpdate());
    // 不观察布局属性自身，防止写 data-composer-compact 引起递归测量。
    const mutations = new MutationObserver((records) => {
      // characterData 只标脏；childList 才可能在 rAF 中改变实际观察集合。
      const hasChildListMutation = records.some((record) => record.type === "childList");
      requestUpdate(hasChildListMutation);
    });
    mutations.observe(root, { childList: true, subtree: true, characterData: true });

    // 挂载时在 layout 阶段同步完成首次 fit，避免未折叠布局先上屏。
    syncObservedElements();
    update();

    return () => {
      disposed = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = null;
      observationsDirty = false;
      mutations.disconnect();
      resize?.disconnect();
      observedElements = new Set();
    };
  }, []);
  return ref;
}

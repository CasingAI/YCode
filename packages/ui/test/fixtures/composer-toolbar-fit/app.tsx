import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

import { useComposerToolbarFit } from "../../../src/prompt-editor/useComposerToolbarFit.js";

/**
 * 独立生产态夹具：只挂载真实 `useComposerToolbarFit` 与它依赖的 DOM 契约。
 *
 * 不引入 ChatPromptEditor、全局 store、RPC 或任何 YCode 运行时；只启动本测试
 * 自己的 Vite、静态服务与无头 Chromium。真实按钮、焦点与 tooltip 都留在 live DOM
 * 中，测量只允许发生在本 hook 创建的隐藏探针上。
 */

type Locale = "zh" | "en";

type ScenarioState = {
  cuaVisible: boolean;
  extraObserved: boolean;
  frameHidden: boolean;
  locale: Locale;
  modelLabel: string;
  noise: number;
  provider: string;
  width: number;
};

type ToolbarProjection = {
  modelIcon: boolean;
  providerCompact: boolean;
  modelMaxWidth: string;
  compact: Array<{ priority: string; compact: boolean }>;
};

type FitSnapshot = {
  activeRole: string | null;
  availableWidth: number;
  contentWidth: number;
  firstFit: ToolbarProjection | null;
  frameWidth: number;
  liveProbeCount: number;
  modelIcon: boolean;
  modelMaxWidth: string;
  providerCompact: boolean;
  compact: Array<{ priority: string; compact: boolean }>;
  controlWidths: number[];
  rootRect: { left: number; right: number; width: number };
  sendRect: { left: number; right: number; width: number };
  tooltipRect: { left: number; right: number; top: number; bottom: number };
  trailingWidth: number;
};

type FitProbe = {
  clones: number;
  clonesThisFrame: number;
  maxClonesPerFrame: number;
  frames: number;
  roDisconnectCalls: number;
  roObserveCalls: number;
  writes: number;
};

type FitApi = {
  appendUnrelated: () => void;
  unmount: () => void;
  burstMixed: () => void;
  focusMode: () => void;
  mutateTextOnly: () => void;
  resetCounters: () => void;
  setPatch: (patch: Partial<ScenarioState>) => void;
  snapshot: () => FitSnapshot;
  waitFrames: (count: number) => Promise<void>;
  waitUntilQuiet: (quietFrames?: number, maxFrames?: number) => Promise<number>;
};

declare global {
  interface Window {
    __composerToolbarFitApi?: FitApi;
    __composerToolbarFitProbe?: FitProbe;
    __composerToolbarFitReady?: boolean;
    __composerToolbarFitUnmount?: () => void;
  }
}

const probe: FitProbe = {
  clones: 0,
  clonesThisFrame: 0,
  frames: 0,
  maxClonesPerFrame: 0,
  roDisconnectCalls: 0,
  roObserveCalls: 0,
  writes: 0,
};
window.__composerToolbarFitProbe = probe;
let noiseSequence = 0;

// 只统计真实 hook 的测量来源；不修改 hook 自身行为。
const originalCloneNode = Element.prototype.cloneNode;
Element.prototype.cloneNode = function instrumentedCloneNode(deep?: boolean) {
  probe.clones += 1;
  probe.clonesThisFrame += 1;
  probe.maxClonesPerFrame = Math.max(probe.maxClonesPerFrame, probe.clonesThisFrame);
  return originalCloneNode.call(this, deep);
} as typeof Element.prototype.cloneNode;

const NativeResizeObserver = window.ResizeObserver;
if (NativeResizeObserver) {
  class InstrumentedResizeObserver extends NativeResizeObserver {
    observe(target: Element, options?: ResizeObserverOptions) {
      probe.roObserveCalls += 1;
      return super.observe(target, options);
    }

    disconnect() {
      probe.roDisconnectCalls += 1;
      return super.disconnect();
    }
  }
  window.ResizeObserver = InstrumentedResizeObserver as typeof ResizeObserver;
}

function frameTick() {
  probe.frames += 1;
  probe.clonesThisFrame = 0;
  requestAnimationFrame(frameTick);
}
requestAnimationFrame(frameTick);

function readProjection(root: HTMLElement): ToolbarProjection {
  return {
    modelIcon: root.dataset.composerModelIcon === "true",
    providerCompact: root.dataset.composerProviderCompact === "true",
    modelMaxWidth: root.style.getPropertyValue("--composer-model-max-width"),
    compact: Array.from(
      root.querySelectorAll<HTMLElement>("[data-composer-collapse-priority]"),
    ).map((control) => ({
      priority: control.dataset.composerCollapsePriority ?? "",
      compact: control.dataset.composerCompact === "true",
    })),
  };
}

function rectOf(element: Element | null) {
  const rect = element?.getBoundingClientRect();
  return {
    left: rect?.left ?? 0,
    right: rect?.right ?? 0,
    top: rect?.top ?? 0,
    bottom: rect?.bottom ?? 0,
    width: rect?.width ?? 0,
  };
}

function Toolbar() {
  const toolbarRef = useComposerToolbarFit();
  const frameRef = useRef<HTMLDivElement>(null);
  const modeRef = useRef<HTMLButtonElement>(null);
  const noiseRef = useRef<HTMLSpanElement>(null);
  const firstFitRef = useRef<ToolbarProjection | null>(null);
  const [state, setState] = useState<ScenarioState>({
    cuaVisible: false,
    extraObserved: false,
    frameHidden: false,
    locale: "zh",
    modelLabel: "Claude Sonnet 4.5",
    noise: 0,
    provider: "AI",
    width: 700,
  });

  const setPatch = useCallback((patch: Partial<ScenarioState>) => {
    flushSync(() => setState((current) => ({ ...current, ...patch })));
  }, []);

  const snapshot = useCallback((): FitSnapshot => {
    const root = toolbarRef.current;
    const frame = frameRef.current;
    const tooltip = frame?.querySelector<HTMLElement>("[data-role=tooltip]") ?? null;
    const send = frame?.querySelector<HTMLElement>("[data-role=send]") ?? null;
    if (!root || !frame) {
      return {
        activeRole: null,
        availableWidth: 0,
        compact: [],
        contentWidth: 0,
        controlWidths: [],
        firstFit: firstFitRef.current,
        frameWidth: 0,
        liveProbeCount: 0,
        modelIcon: false,
        modelMaxWidth: "",
        providerCompact: false,
        rootRect: rectOf(null),
        sendRect: rectOf(null),
        tooltipRect: rectOf(null),
        trailingWidth: 0,
      };
    }
    const projection = readProjection(root);
    const available = root.querySelector<HTMLElement>("[data-composer-leading-actions]");
    const content = root.querySelector<HTMLElement>("[data-composer-leading-content]");
    const trailing = root.querySelector<HTMLElement>("[data-composer-trailing-actions]");
    return {
      ...projection,
      activeRole: document.activeElement?.getAttribute("data-role") ?? null,
      availableWidth: rectOf(available).width,
      compact: projection.compact,
      contentWidth: rectOf(content).width,
      controlWidths: projection.compact.map(
        (_, index) =>
          rectOf(root.querySelectorAll("[data-composer-collapse-priority]")[index]).width,
      ),
      firstFit: firstFitRef.current,
      frameWidth: frame.getBoundingClientRect().width,
      liveProbeCount: frame.querySelectorAll(".toolbar[aria-hidden='true']").length,
      rootRect: rectOf(root),
      sendRect: rectOf(send),
      tooltipRect: rectOf(tooltip),
      trailingWidth: rectOf(trailing).width,
    };
  }, [toolbarRef]);

  const waitFrames = useCallback((count: number) => {
    return new Promise<void>((resolve) => {
      let remaining = Math.max(1, count);
      const step = () => {
        remaining -= 1;
        if (remaining <= 0) resolve();
        else requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  }, []);

  const waitUntilQuiet = useCallback(
    async (quietFrames = 4, maxFrames = 120) => {
      let quiet = 0;
      for (let index = 0; index < maxFrames; index += 1) {
        await waitFrames(1);
        if (probe.writes === 0 && probe.clones === 0) quiet += 1;
        else quiet = 0;
        if (quiet >= quietFrames) return index + 1;
      }
      return -1;
    },
    [waitFrames],
  );

  const mutateNoise = useCallback((count: number) => {
    const node = noiseRef.current?.firstChild;
    if (!node) return;
    for (let index = 0; index < count; index += 1) {
      noiseSequence += 1;
      // 每次写入不同文本，确保产生真实 characterData mutation。
      node.textContent = `${noiseSequence}-${"x".repeat(index + 1)}`;
    }
  }, []);

  const burstMixed = useCallback(() => {
    // 同一任务内制造多种通知：childList（CUA）、characterData（noise）与几何变化
    // （宽度往返）。旧实现会在同帧执行多次探针，新实现只允许一次。
    setPatch({ width: 460 });
    setPatch({ width: 500 });
    setPatch({ width: 480, cuaVisible: true });
    mutateNoise(8);
  }, [mutateNoise, setPatch]);

  const appendUnrelated = useCallback(() => {
    const content = toolbarRef.current?.querySelector<HTMLElement>(
      "[data-composer-leading-content]",
    );
    if (!content) return;
    const span = document.createElement("span");
    span.dataset.unrelated = "true";
    span.className = "unrelated";
    span.textContent = "unrelated";
    content.append(span);
  }, [toolbarRef]);

  useLayoutEffect(() => {
    const root = toolbarRef.current;
    if (!root) return;
    // hook 的 useLayoutEffect 先执行，因此这里读到的是首次同步 fit 的结果。
    firstFitRef.current = readProjection(root);
    const observer = new MutationObserver((records) => {
      probe.writes += records.length;
    });
    observer.observe(root, {
      attributeFilter: [
        "data-composer-compact",
        "data-composer-model-icon",
        "data-composer-provider-compact",
        "style",
      ],
      attributes: true,
      subtree: true,
    });
    return () => observer.disconnect();
  }, [toolbarRef]);

  useLayoutEffect(() => {
    window.__composerToolbarFitApi = {
      appendUnrelated,
      unmount: () => window.__composerToolbarFitUnmount?.(),
      burstMixed,
      focusMode: () => modeRef.current?.focus(),
      mutateTextOnly: () => mutateNoise(12),
      resetCounters: () => {
        probe.clones = 0;
        probe.clonesThisFrame = 0;
        probe.maxClonesPerFrame = 0;
        probe.roDisconnectCalls = 0;
        probe.roObserveCalls = 0;
        probe.writes = 0;
      },
      setPatch,
      snapshot,
      waitFrames,
      waitUntilQuiet,
    };
    window.__composerToolbarFitReady = true;
  }, [appendUnrelated, burstMixed, mutateNoise, setPatch, snapshot, waitFrames, waitUntilQuiet]);

  return (
    <div
      ref={frameRef}
      className="frame"
      data-hidden={state.frameHidden ? "true" : "false"}
      style={{
        display: state.frameHidden ? "none" : "block",
        width: `${state.width}px`,
      }}
    >
      <div ref={toolbarRef} className="toolbar">
        <div className="leading" data-composer-leading-actions>
          <div className="leading-content" data-composer-leading-content>
            <span className="mode-wrap">
              <button
                ref={modeRef}
                type="button"
                className="mode"
                data-composer-collapse-priority="0"
                data-role="mode"
                style={{ width: state.locale === "en" ? 112 : 88 }}
              >
                {state.locale === "en" ? "Standard Mode" : "标准模式"}
              </button>
              <span className="tooltip" data-role="tooltip">
                {state.locale === "en" ? "Mode" : "模式"}
              </span>
            </span>
            {state.cuaVisible ? (
              <button
                type="button"
                className="cua"
                data-composer-collapse-priority="1"
                data-role="cua"
              >
                Computer Use
              </button>
            ) : null}
          </div>
        </div>
        <div className="trailing" data-composer-trailing-actions>
          <span className="prefix-line">
            <span className="composer-provider-prefix">{state.provider}</span>
          </span>
          <button type="button" className="composer-model-trigger" data-role="model">
            <span className="model-label">{state.modelLabel}</span>
          </button>
          <button type="button" className="send" data-role="send">
            ↑
          </button>
        </div>
        {state.extraObserved ? (
          <span className="unrelated" data-composer-leading-actions data-role="extra-observed" />
        ) : null}
      </div>
      <span ref={noiseRef} className="noise" aria-hidden>
        {state.noise}
      </span>
    </div>
  );
}

const container = document.getElementById("root");
if (!container) throw new Error("找不到 #root");
const reactRoot = createRoot(container);
window.__composerToolbarFitUnmount = () => reactRoot.unmount();
reactRoot.render(<Toolbar />);

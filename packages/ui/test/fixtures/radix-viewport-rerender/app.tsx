import { useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

/**
 * 独立生产态夹具：只挂载真实 Radix Select / ScrollArea，不引入 UI 业务组件。
 *
 * 入口由 shell.ts 决定（ESM dist/index.mjs 或 CJS dist/index.js）。
 * 测量由 public/probe-init.js 完成；本文件只提供可控的状态与可序列化的快照。
 */

export type RadixModules = {
  Select: any;
  ScrollArea: any;
};

type StyleRecord = {
  id: number;
  first: boolean;
  phase: string;
  connected: boolean;
  html: string;
  nonce: string | null;
};

type FrameCommit = {
  kind: "scroll" | "select";
  phase: string;
  connected: boolean;
  value: string;
};

type ProbeState = {
  phase: string;
  records: StyleRecord[];
  frameCommits: FrameCommit[];
  fragments: number;
  fragmentProbe: boolean;
  innerHtmlProbe: boolean;
  frameProbe: boolean;
  reset: (phase?: string) => void;
};

type Snapshot = {
  buildMode: string | null;
  selectOpen: boolean;
  selectValue: string;
  selectTriggerText: string | null;
  selectViewportInDocument: boolean;
  selectStyleInDocument: boolean;
  selectStyleMarker: string | null;
  selectStyleNonce: string | null;
  selectStyleText: string | null;
  selectOptionTexts: string[];
  scrollViewportInDocument: boolean;
  scrollStyleInDocument: boolean;
  scrollStyleMarker: string | null;
  scrollStyleNonce: string | null;
  scrollStyleText: string | null;
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
  scrollThumbState: string | null;
  scrollThumbHeight: number;
  fragmentCount: number;
  fragmentProbe: boolean;
  innerHtmlProbe: boolean;
  frameProbe: boolean;
  records: StyleRecord[];
  frameCommits: FrameCommit[];
};

declare global {
  interface Window {
    __radixApp?: Record<string, unknown>;
    __radixAppReady?: boolean;
    __radixProbe?: ProbeState;
  }
}

const OPTIONS = ["alpha", "beta", "gamma"] as const;

function styleFor(selectorText: string): HTMLStyleElement | null {
  return Array.from(document.querySelectorAll("style")).find((style) =>
    (style.textContent ?? "").includes(selectorText),
  ) as HTMLStyleElement | null;
}

function viewportFor(selector: string): HTMLDivElement | null {
  return document.querySelector(selector) as HTMLDivElement | null;
}

function Harness({ modules }: { modules: RadixModules }) {
  const { Select, ScrollArea } = modules;
  const [frame, setFrame] = useState(0);
  const [selectOpen, setSelectOpen] = useState(false);
  const [selectValue, setSelectValue] = useState<string>("alpha");
  const [nonce, setNonce] = useState("nonce-a");
  const [scrollCount, setScrollCount] = useState(30);
  const [scrollKey, setScrollKey] = useState(0);
  const selectViewportRef = useRef<HTMLDivElement | null>(null);
  const scrollViewportRef = useRef<HTMLDivElement | null>(null);

  const controller = {
    open: (next: boolean) => flushSync(() => setSelectOpen(next)),
    reset: (phase: string) => window.__radixProbe?.reset(phase),
    setNonce: (next: string) => flushSync(() => setNonce(next)),
    setScrollCount: (next: number) => flushSync(() => setScrollCount(next)),
    setScrollTop: (top: number) => {
      const viewport = scrollViewportRef.current;
      if (viewport) viewport.scrollTop = top;
      return viewport?.scrollTop ?? null;
    },
    setValue: (next: string) => flushSync(() => setSelectValue(next)),
    remountScroll: () => flushSync(() => setScrollKey((key) => key + 1)),
    forceRerenders: (count: number) => {
      for (let index = 0; index < count; index += 1) {
        flushSync(() => setFrame((value) => value + 1));
      }
    },
    snapshot: (): Snapshot => {
      const probe = window.__radixProbe;
      const selectViewport = viewportFor("[data-radix-select-viewport]");
      const scrollViewport = viewportFor("[data-radix-scroll-area-viewport]");
      const selectStyle = styleFor("data-radix-select-viewport");
      const scrollStyle = styleFor("data-radix-scroll-area-viewport");
      const thumb = document.querySelector("[data-testid=scroll-thumb]") as HTMLElement | null;
      return {
        buildMode: process.env.NODE_ENV ?? null,
        fragmentCount: probe?.fragments ?? 0,
        fragmentProbe: probe?.fragmentProbe ?? false,
        frameCommits: probe?.frameCommits ?? [],
        frameProbe: probe?.frameProbe ?? false,
        innerHtmlProbe: probe?.innerHtmlProbe ?? false,
        records: probe?.records ?? [],
        scrollThumbHeight: thumb?.getBoundingClientRect().height ?? 0,
        scrollThumbState: thumb?.getAttribute("data-state") ?? null,
        scrollViewportInDocument: Boolean(scrollViewport),
        scrollStyleInDocument: Boolean(scrollStyle),
        scrollStyleMarker: scrollStyle?.dataset.probeMarker ?? null,
        scrollStyleNonce: scrollStyle?.getAttribute("nonce") ?? null,
        scrollStyleText: scrollStyle?.textContent ?? null,
        scrollHeight: scrollViewport?.scrollHeight ?? 0,
        clientHeight: scrollViewport?.clientHeight ?? 0,
        scrollTop: scrollViewport?.scrollTop ?? 0,
        selectOpen,
        selectTriggerText:
          (document.querySelector("[data-testid=select-trigger]")?.textContent ?? null) || null,
        selectValue,
        selectViewportInDocument: Boolean(selectViewport),
        selectStyleInDocument: Boolean(selectStyle),
        selectStyleMarker: selectStyle?.dataset.probeMarker ?? null,
        selectStyleNonce: selectStyle?.getAttribute("nonce") ?? null,
        selectStyleText: selectStyle?.textContent ?? null,
        selectOptionTexts: Array.from(document.querySelectorAll('[role="option"]')).map(
          (option) => option.textContent ?? "",
        ),
      };
    },
  };

  useLayoutEffect(() => {
    window.__radixApp = controller as unknown as Record<string, unknown>;
    window.__radixAppReady = true;
  });

  return (
    <main style={{ display: "flex", flexDirection: "column", gap: 24, padding: 16 }}>
      <section aria-label="select-section">
        <Select.Root
          open={selectOpen}
          onOpenChange={setSelectOpen}
          value={selectValue}
          onValueChange={setSelectValue}
        >
          <Select.Trigger data-testid="select-trigger" aria-label="select trigger">
            <Select.Value placeholder="none" />
            <Select.Icon>v</Select.Icon>
          </Select.Trigger>
          <Select.Portal>
            <Select.Content
              position="popper"
              sideOffset={4}
              style={{ background: "#fff", zIndex: 1 }}
            >
              <Select.Viewport
                data-frame={frame}
                nonce={nonce}
                ref={selectViewportRef}
                style={{ padding: 4 }}
              >
                {OPTIONS.map((option) => (
                  <Select.Item key={option} value={option} style={{ padding: "2px 8px" }}>
                    <Select.ItemText>{option}</Select.ItemText>
                  </Select.Item>
                ))}
              </Select.Viewport>
            </Select.Content>
          </Select.Portal>
        </Select.Root>
      </section>

      <section aria-label="scroll-section">
        <ScrollArea.Root
          key={scrollKey}
          type="always"
          style={{ width: 240, height: 100, border: "1px solid #ccc" }}
        >
          <ScrollArea.Viewport
            data-frame={frame}
            nonce={nonce}
            ref={scrollViewportRef}
            style={{ width: "100%", height: "100%" }}
          >
            <div data-testid="scroll-content" style={{ height: scrollCount * 14 }}>
              {Array.from({ length: scrollCount }, (_, index) => (
                <div key={index} style={{ height: 14, lineHeight: "14px" }}>
                  row {index}
                </div>
              ))}
            </div>
          </ScrollArea.Viewport>
          <ScrollArea.Scrollbar orientation="vertical" style={{ width: 8 }}>
            <ScrollArea.Thumb data-testid="scroll-thumb" style={{ background: "#888" }} />
          </ScrollArea.Scrollbar>
          <ScrollArea.Corner />
        </ScrollArea.Root>
      </section>
    </main>
  );
}

export function startProbeApp(modules: RadixModules) {
  const rootElement = document.getElementById("root");
  if (!rootElement) throw new Error("missing #root");
  createRoot(rootElement).render(<Harness modules={modules} />);
}

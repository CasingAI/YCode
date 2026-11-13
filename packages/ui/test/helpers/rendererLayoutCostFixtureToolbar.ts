/**
 * 工具栏 fixture 页面源码。
 *
 * 驱动真实 `useComposerToolbarFit`（prechange 由解析层替换为快照版本），DOM 复刻生产
 * 选择器契约：leading-actions / leading-content / trailing-actions / collapse-priority /
 * provider-prefix / model-trigger。完成信号是 `fitVersion`：每次操作后等探针投影在
 * 连续帧上稳定，再前进版本号；`signals()` 只读 dataset 与 style 文本，不读几何。
 */
import { installProductCssImport } from "./rendererLayoutCostFixtureCss.js";

export const TOOLBAR_SOURCE = `${installProductCssImport()}
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { useComposerToolbarFit } from "@/prompt-editor/useComposerToolbarFit.js";

const FIT = { version: 0, pending: 0, last: null, stable: 0, framesAfterOp: 0, running: false };

function fitSignature(root) {
  if (!root) return "";
  const live = root.querySelectorAll("[data-composer-collapse-priority]");
  let compact = "";
  for (const control of live) compact += control.dataset.composerCompact === "true" ? "1" : "0";
  return [
    root.dataset.composerModelIcon === "true" ? "M" : "-",
    root.dataset.composerProviderCompact === "true" ? "P" : "-",
    root.style.getPropertyValue("--composer-model-max-width"),
    compact,
  ].join("|");
}

// 一次操作 = 等投影在连续帧上稳定 2 次；稳定只说明本帧没有新的属性写入，
// 不是固定 settle，也不推迟到墙钟超时。
function pumpFit() {
  FIT.running = true;
  const root = document.querySelector("[data-cost-toolbar-root]");
  const signature = fitSignature(root);
  if (FIT.pending > 0) FIT.framesAfterOp += 1;
  if (signature === FIT.last) FIT.stable += 1;
  else { FIT.last = signature; FIT.stable = 0; }
  if (FIT.pending > 0 && FIT.framesAfterOp >= 1 && FIT.stable >= 2) {
    // 只消费已经稳定下来的操作；排在同一帧里的后续操作继续走下一轮稳定检测。
    FIT.pending -= 1;
    FIT.framesAfterOp = 0;
    FIT.version += 1;
    if (FIT.pending > 0) requestAnimationFrame(pumpFit);
    else FIT.running = false;
    return;
  }
  if (FIT.pending > 0) requestAnimationFrame(pumpFit);
  else FIT.running = false;
}

function requestFitSettle() {
  FIT.pending += 1;
  if (!FIT.running) requestAnimationFrame(pumpFit);
}

function readToolbarSignals() {
  const root = document.querySelector("[data-cost-toolbar-root]");
  if (!root) {
    return { width: null, controls: 0, compact: 0, modelIcon: false, providerCompact: false, modelMaxWidth: "", fitVersion: FIT.version };
  }
  const live = root.querySelectorAll("[data-composer-collapse-priority]");
  let compact = 0;
  for (const control of live) if (control.dataset.composerCompact === "true") compact += 1;
  return {
    width: root.parentElement ? Number.parseFloat(root.parentElement.style.width) || null : null,
    controls: live.length,
    compact: compact,
    modelIcon: root.dataset.composerModelIcon === "true",
    providerCompact: root.dataset.composerProviderCompact === "true",
    modelMaxWidth: root.style.getPropertyValue("--composer-model-max-width"),
    fitVersion: FIT.version,
  };
}

function ToolbarFixture() {
  const toolbarRef = useComposerToolbarFit();
  const [width, setWidth] = useState(1200);
  const [cuaVisible, setCuaVisible] = useState(true);
  const [label, setLabel] = useState("模型 A");
  const mountedRef = useRef(false);

  useEffect(function () {
    // 挂载后的首轮 fit 已经由 layout effect 同步完成；这里只排一个完成信号。
    if (!mountedRef.current) {
      mountedRef.current = true;
      requestFitSettle();
    }
    globalThis.__costToolbar = {
      setWidth: function (value) { requestFitSettle(); setWidth(value); },
      setCua: function (value) { requestFitSettle(); setCuaVisible(value); },
      nudge: function () {
        requestFitSettle();
        setLabel(function (current) { return current === "模型 A" ? "模型 A " : "模型 A"; });
      },
      read: readToolbarSignals,
      signals: readToolbarSignals,
    };
  }, []);

  return (
    <div data-cost-root="toolbar" data-cost-ready="1" style={{ width: width + "px", padding: 8, background: "#fff" }}>
      <div
        ref={toolbarRef}
        data-cost-toolbar-root
        style={{ display: "flex", gap: "12px", alignItems: "flex-end", width: "100%" }}
      >
        <div data-composer-leading-actions style={{ flex: "1 1 0", minWidth: 0, display: "flex", alignItems: "center" }}>
          <div data-composer-leading-content style={{ display: "flex", gap: 4, flexShrink: 0, alignItems: "center" }}>
            <span style={{ display: "inline-block", width: 120, overflow: "hidden", whiteSpace: "nowrap" }}>
              <span className="composer-provider-prefix">provider name that is long</span>
            </span>
            <button data-composer-collapse-priority="0" style={{ whiteSpace: "nowrap" }}>{"Mode " + label}</button>
            {cuaVisible ? <button data-composer-collapse-priority="1" style={{ whiteSpace: "nowrap" }}>CUA</button> : null}
            <button data-composer-collapse-priority="2" style={{ whiteSpace: "nowrap" }}>Extra</button>
          </div>
        </div>
        <div data-composer-trailing-actions style={{ marginLeft: "auto", display: "flex", gap: 6, flexShrink: 0 }}>
          <button className="composer-model-trigger" style={{ width: 120, whiteSpace: "nowrap", overflow: "hidden" }}>{label}</button>
          <button style={{ whiteSpace: "nowrap" }}>Send</button>
        </div>
      </div>
    </div>
  );
}

function mountToolbar() {
  const root = createRoot(document.getElementById("root"));
  root.render(<ToolbarFixture />);
}

globalThis.__costToolbar = {
  mount: mountToolbar,
  setWidth: function () {},
  setCua: function () {},
  nudge: function () {},
  read: readToolbarSignals,
  signals: readToolbarSignals,
};

globalThis.__costFixture = {
  version: 2,
  deferredMount: true,
  capabilities: ["deferred-mount", "toolbar.signals", "toolbar.fit-version"],
  surfaces: ["toolbar"],
};
`;

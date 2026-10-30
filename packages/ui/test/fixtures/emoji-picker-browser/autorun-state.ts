// 自检状态与可见报告。结果只通过页面 DOM 可见输出表达：
// #e2e-report / #e2e-status / #e2e-lines / #e2e-result-json 与 document.title。
export type LocaleId = "zh" | "en";

export interface E2EAssertion {
  locale: LocaleId | "global";
  name: string;
  ok: boolean;
  detail?: string;
}

export interface E2EEvidence {
  externalRequests: string[];
  requestCount: number;
  localStorageKeys: string[];
  sessionStorageKeys: string[];
  frimousseStorageKeys: string[];
  consoleErrors: string[];
  viewport: { width: number; height: number };
}

export interface E2EResult {
  status: "running" | "pass" | "fail";
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
  origin: string;
  viewport: { width: number; height: number };
  assertions: E2EAssertion[];
  evidence: E2EEvidence;
}

declare global {
  interface Window {
    __e2eResult?: E2EResult;
  }
}

export function emptyEvidence(): E2EEvidence {
  return {
    externalRequests: [],
    requestCount: 0,
    localStorageKeys: [],
    sessionStorageKeys: [],
    frimousseStorageKeys: [],
    consoleErrors: [],
    viewport: { width: window.innerWidth, height: window.innerHeight },
  };
}

export const state: { result: E2EResult } = {
  result: {
    status: "running",
    startedAt: 0,
    origin: "",
    viewport: { width: window.innerWidth, height: window.innerHeight },
    assertions: [],
    evidence: emptyEvidence(),
  },
};

function ensureReport(): void {
  if (document.getElementById("e2e-report")) return;
  const aside = document.createElement("aside");
  aside.id = "e2e-report";
  Object.assign(aside.style, {
    position: "fixed",
    top: "0",
    right: "0",
    width: "min(420px, 44vw)",
    maxHeight: "100vh",
    overflow: "auto",
    background: "#ffffff",
    color: "#18181b",
    borderLeft: "1px solid #d4d4d8",
    padding: "8px 10px",
    font: "12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace",
    zIndex: "2147483647",
    // 不拦截真实点击；结果仅用于阅读/截图。
    pointerEvents: "none",
    boxShadow: "0 0 12px rgba(0,0,0,0.15)",
  });
  aside.innerHTML =
    '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px">' +
    '<div id="e2e-status" style="font-weight:700;margin-bottom:6px"></div>' +
    // 窄视口截图时把明细收起，只留一行状态，避免固定报表遮住真实 Dialog。
    '<button id="e2e-report-toggle" type="button" style="pointer-events:auto;flex:none;border:1px solid #d4d4d8;border-radius:4px;background:#fafafa;padding:0 6px;font:inherit;cursor:pointer">收起</button>' +
    "</div>" +
    '<div id="e2e-report-body">' +
    '<pre id="e2e-lines" style="white-space:pre-wrap;margin:0"></pre>' +
    '<pre id="e2e-result-json" style="display:none"></pre>' +
    "</div>";
  document.body.appendChild(aside);
  const body = aside.querySelector<HTMLElement>("#e2e-report-body");
  const toggle = aside.querySelector<HTMLButtonElement>("#e2e-report-toggle");
  toggle?.addEventListener("click", () => {
    if (!body) return;
    const collapsed = !body.hidden;
    body.hidden = collapsed;
    toggle.textContent = collapsed ? "展开" : "收起";
  });
}

export function writeStatus(statusText: string, tone: "running" | "pass" | "fail"): void {
  const status = document.getElementById("e2e-status");
  if (status) {
    status.textContent = statusText;
    status.style.color = tone === "pass" ? "#15803d" : tone === "fail" ? "#b91c1c" : "#1d4ed8";
  }
  document.body.dataset.e2eStatus = tone;
  document.documentElement.dataset.e2eStatus = tone;
  const json = document.getElementById("e2e-result-json");
  if (json) json.textContent = JSON.stringify(state.result, null, 2);
  document.title = `E2E ${tone.toUpperCase()} ${state.result.assertions.filter((item) => item.ok).length}/${state.result.assertions.length}`;
}

export function report(assertion: E2EAssertion): void {
  ensureReport();
  state.result.assertions.push(assertion);
  const lines = document.getElementById("e2e-lines");
  if (lines) {
    const suffix = assertion.detail ? ` — ${assertion.detail}` : "";
    lines.textContent += `${assertion.ok ? "PASS" : "FAIL"} [${assertion.locale}] ${assertion.name}${suffix}\n`;
  }
  writeStatus(`RUNNING ${state.result.assertions.length} 项`, "running");
}

export function assertStep(
  locale: LocaleId | "global",
  name: string,
  condition: unknown,
  detail?: string,
): asserts condition {
  report({ locale, name, ok: Boolean(condition), detail });
  if (!condition) throw new Error(`${name}${detail ? `: ${detail}` : ""}`);
}

export { ensureReport };

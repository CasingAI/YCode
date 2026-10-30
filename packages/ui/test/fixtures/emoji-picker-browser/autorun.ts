// 浏览器自检编排。入口文件只负责顺序流程；DOM 断言在 autorun-dom.ts，
// 可见报告状态在 autorun-state.ts，避免单文件超过 lint 的 400 行上限。
import {
  assertAssetApi,
  assertDialogGeometry,
  assertSelectedRender,
  assertUnknownFallback,
  closeLocale,
  dialogContent,
  findVisibleEmoji,
  getToggle,
  isExternalRequest,
  isVisible,
  openLocale,
  ROCKET,
  searchLocale,
  waitFor,
  waitForVisibleGrid,
} from "./autorun-dom.js";
import {
  assertStep,
  emptyEvidence,
  ensureReport,
  report,
  state,
  writeStatus,
} from "./autorun-state.js";
import type { LocaleId } from "./autorun-state.js";

async function runLocale(locale: LocaleId, query: string, label: string): Promise<void> {
  await waitFor(
    `[${locale}] 夹具渲染`,
    () => document.querySelector(`[data-testid="${locale}-section"]`),
    15_000,
  );
  const section = document.querySelector(`[data-testid="${locale}-section"]`);
  assertStep(
    locale,
    "夹具 section 与打开按钮可见",
    isVisible(section) && isVisible(getToggle(locale)),
  );

  const dialog = await openLocale(locale);
  assertDialogGeometry(locale, dialog);
  await searchLocale(locale, dialog, query, label);

  findVisibleEmoji(dialog, label)!.click();
  await waitFor(`[${locale}] 选中后 Dialog 关闭`, () => !dialogContent(), 15_000);
  const selected = document
    .querySelector(`[data-testid="${locale}-selected"]`)
    ?.textContent?.trim();
  const selectedCount = document
    .querySelector(`[data-testid="${locale}-count"]`)
    ?.textContent?.trim();
  assertStep(
    locale,
    "真实 button.click 选中回调并自动关闭",
    selected === ROCKET && selectedCount === "1",
    `selected=${JSON.stringify(selected)} count=${selectedCount}`,
  );

  await assertSelectedRender(locale);
  await assertUnknownFallback(locale);
  await assertAssetApi(locale);

  getToggle(locale).click();
  const reopenedCount = await waitForVisibleGrid(locale);
  assertStep(
    locale,
    "关闭后可重新打开且网格恢复",
    reopenedCount > 0,
    `可见按钮 ${reopenedCount} 个`,
  );
  // 两个语言都在结束后关闭，避免后续 locale 打开时 dialogContent() 命中上一个对话框；
  // 全部断言完成后统一重开 zh 对话框留给截图。
  await closeLocale(locale);
  assertStep(locale, "重开后再次关闭面板", true);
}

function collectEvidence(): void {
  const requests = [...(window.__e2eRequests ?? [])];
  const external = requests
    .filter((request) => isExternalRequest(request.url))
    .map((item) => item.url);
  const localStorageKeys = Object.keys(window.localStorage);
  const sessionStorageKeys = Object.keys(window.sessionStorage);
  const frimousseStorageKeys = [...localStorageKeys, ...sessionStorageKeys].filter((key) =>
    key.toLowerCase().includes("frimousse"),
  );
  const consoleErrors = [...(window.__e2eConsoleErrors ?? [])];
  state.result.evidence = {
    externalRequests: external,
    requestCount: requests.length,
    localStorageKeys,
    sessionStorageKeys,
    frimousseStorageKeys,
    consoleErrors,
    viewport: { width: window.innerWidth, height: window.innerHeight },
  };

  assertStep(
    "global",
    "运行期无外部网络请求",
    external.length === 0,
    external.length > 0 ? external.slice(0, 5).join(", ") : `本地请求 ${requests.length} 个`,
  );
  assertStep(
    "global",
    "localStorage/sessionStorage 无 frimousse 历史缓存",
    frimousseStorageKeys.length === 0,
    `keys=${JSON.stringify([...localStorageKeys, ...sessionStorageKeys].slice(0, 8))}`,
  );
  assertStep(
    "global",
    "页面无 console.error",
    consoleErrors.length === 0,
    consoleErrors.slice(0, 3).join(" | "),
  );
}

async function runAutorun(): Promise<void> {
  ensureReport();
  state.result = {
    ...state.result,
    status: "running",
    startedAt: Date.now(),
    origin: location.origin,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    assertions: [],
    evidence: emptyEvidence(),
  };
  window.__e2eResult = state.result;
  writeStatus("RUNNING 0 项", "running");
  report({
    locale: "global",
    name: `autorun 开始 ${location.href} viewport=${window.innerWidth}x${window.innerHeight}`,
    ok: true,
  });

  // 清空本测试 origin 的历史缓存，确保结果不依赖 localStorage/sessionStorage。
  try {
    window.localStorage.clear();
    window.sessionStorage.clear();
  } catch (error) {
    report({ locale: "global", name: "清理 storage 失败", ok: false, detail: String(error) });
  }

  try {
    await waitFor(
      "两栏夹具渲染",
      () =>
        document.querySelector('[data-testid="zh-toggle"]') &&
        document.querySelector('[data-testid="en-toggle"]'),
      15_000,
    );
    assertStep("global", "zh/en 两栏夹具已挂载", true);

    for (const [locale, query, label] of [
      ["zh", "火箭", "火箭"],
      ["en", "rocket", "Rocket"],
    ] as const) {
      try {
        await runLocale(locale, query, label);
      } catch (error) {
        report({
          locale,
          name: "交互序列中断",
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
        });
        try {
          await closeLocale(locale);
        } catch {
          // 清理失败不覆盖原始失败原因。
        }
      }
    }

    try {
      collectEvidence();
    } catch (error) {
      report({
        locale: "global",
        name: "证据采集失败",
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }

    // 所有断言完成后重新打开 zh 对话框并保留，截图可直接复核真实 320px 外壳。
    try {
      await openLocale("zh");
      report({ locale: "global", name: "截图前重新打开 zh 真实对话框", ok: true });
    } catch (error) {
      report({
        locale: "global",
        name: "截图前打开对话框失败",
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  } catch (error) {
    report({
      locale: "global",
      name: "autorun 启动失败",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  const passed = state.result.assertions.filter((item) => item.ok).length;
  const total = state.result.assertions.length;
  state.result.status = passed === total ? "pass" : "fail";
  state.result.finishedAt = Date.now();
  state.result.durationMs = state.result.finishedAt - state.result.startedAt;
  report({
    locale: "global",
    name: `RESULT ${state.result.status.toUpperCase()} ${passed}/${total} ${state.result.durationMs}ms viewport=${window.innerWidth}x${window.innerHeight}`,
    ok: state.result.status === "pass",
  });
  writeStatus(`${state.result.status.toUpperCase()} ${passed}/${total}`, state.result.status);
}

export function maybeStartAutorun(): void {
  const params = new URLSearchParams(location.search);
  const fromHash = new URLSearchParams(location.hash.replace(/^#/, "")).get("autorun");
  if (params.get("autorun") !== "1" && fromHash !== "1") return;
  void runAutorun();
}

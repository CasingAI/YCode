// 真实 Dialog / Frimousse DOM 的查询与断言。所有尺寸与图片加载断言都基于
// 浏览器实际布局（getBoundingClientRect / naturalWidth），不使用假 CSS 容器。
import { assertStep, report, state } from "./autorun-state.js";
import type { LocaleId } from "./autorun-state.js";

const ROCKET = "\u{1F680}";
const UNKNOWN_EMOJI = "\u{10FFFD}";
const STEP_TIMEOUT_MS = 20_000;

export function isVisible(element: Element | null): element is HTMLElement {
  if (!(element instanceof HTMLElement)) return false;
  // frimousse 的隐藏测量 sizer 包在 aria-hidden 容器里，不算可见网格。
  if (element.closest('[aria-hidden="true"]')) return false;
  const style = getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
    return false;
  }
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

export function dialogContent(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-slot="dialog-content"]');
}

function visibleEmojis(host: Element): HTMLElement[] {
  return Array.from(host.querySelectorAll("button[frimousse-emoji]")).filter(
    (button) => isVisible(button) && Boolean(button.getAttribute("aria-label")),
  );
}

export function findVisibleEmoji(host: Element, label: string): HTMLButtonElement | null {
  const match = visibleEmojis(host).find((button) => button.getAttribute("aria-label") === label);
  return (match as HTMLButtonElement | undefined) ?? null;
}

function loadingVisible(host: Element): boolean {
  return isVisible(host.querySelector("span[frimousse-loading]"));
}

export function isExternalRequest(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl, location.href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return !["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}

export function waitFor<T>(
  label: string,
  predicate: () => T | false | null | undefined,
  timeoutMs = STEP_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const startedAt = performance.now();
    let settled = false;
    const observer = new MutationObserver(check);
    const interval = window.setInterval(check, 50);
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      window.clearInterval(interval);
      action();
    };
    function check(): void {
      let value: T | false | null | undefined;
      try {
        value = predicate();
      } catch (error) {
        finish(() => reject(error));
        return;
      }
      if (value) finish(() => resolve(value));
      else if (performance.now() - startedAt > timeoutMs) {
        finish(() => reject(new Error(`等待超时: ${label}`)));
      }
    }
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    check();
  });
}

export function getToggle(locale: LocaleId): HTMLButtonElement {
  const toggle = document.querySelector<HTMLButtonElement>(`[data-testid="${locale}-toggle"]`);
  if (!toggle) throw new Error(`${locale} 打开按钮不存在`);
  return toggle;
}

function overflowOf(element: HTMLElement): number {
  return element.scrollWidth - element.clientWidth;
}

function assertNoHorizontalScroll(locale: LocaleId, label: string, element: Element | null): void {
  if (!(element instanceof HTMLElement)) {
    report({ locale, name: `${label} 无横向溢出`, ok: false, detail: "元素不存在" });
    throw new Error(`${label} 元素不存在`);
  }
  assertStep(
    locale,
    `${label} 无横向溢出`,
    overflowOf(element) <= 1,
    `scrollWidth=${element.scrollWidth} clientWidth=${element.clientWidth}`,
  );
}

export async function waitForVisibleGrid(locale: LocaleId): Promise<number> {
  await waitFor(`[${locale}] 面板可见、loading 消失且网格可见`, () => {
    const dialog = dialogContent();
    return Boolean(dialog && !loadingVisible(dialog) && visibleEmojis(dialog).length > 0);
  });
  return visibleEmojis(dialogContent()!).length;
}

export async function openLocale(locale: LocaleId): Promise<HTMLElement> {
  getToggle(locale).click();
  const dialog = await waitFor(`[${locale}] 真实 Dialog 打开`, () => {
    const element = dialogContent();
    return element && element.getAttribute("data-state") !== "closed" ? element : false;
  });
  const count = await waitForVisibleGrid(locale);
  assertStep(locale, "loading 消失且出现可见表情网格", count > 0, `可见按钮 ${count} 个`);
  // Dialog 有 100ms zoom-in 动画；夹具的 rAF 是定时器模拟，动画期间测量会读到
  // 缩放中的宽度（实测英文栏 315.3px）。等动画结束后再断言几何尺寸。
  await Promise.all(dialog.getAnimations({ subtree: true }).map((animation) => animation.finished));
  return dialog;
}

export async function closeLocale(locale: LocaleId): Promise<void> {
  if (!dialogContent()) return;
  getToggle(locale).click();
  await waitFor(`[${locale}] 面板关闭`, () => !dialogContent(), 10_000);
}

export function assertDialogGeometry(locale: LocaleId, dialog: HTMLElement): void {
  const rect = dialog.getBoundingClientRect();
  const style = getComputedStyle(dialog);
  const px = (value: string) => Number.parseFloat(value) || 0;
  const contentBox =
    rect.width -
    px(style.paddingLeft) -
    px(style.paddingRight) -
    px(style.borderLeftWidth) -
    px(style.borderRightWidth);
  const viewportWidth = window.innerWidth;
  state.result.viewport = { width: viewportWidth, height: window.innerHeight };

  // Tailwind sm 断点 = 40rem = 640px：只有达到它 sm:max-w-xs 才生效。
  // 480–639px 仍走 max-w-[calc(100%-2rem)]，不能按桌面 320px 断言。
  if (viewportWidth >= 640) {
    // 真实 DialogContent：sm:max-w-xs = 320px 外壳，p-4 + 1px border = 286px 内容盒。
    assertStep(
      locale,
      "桌面视口真实 Dialog 外壳 320px、内容盒 286px",
      Math.abs(rect.width - 320) <= 1 && Math.abs(contentBox - 286) <= 1.5,
      `viewport=${viewportWidth} shell=${rect.width.toFixed(1)} contentBox=${contentBox.toFixed(1)}`,
    );
  } else {
    // 窄视口：max-w-[calc(100%-2rem)] 生效，外壳贴合视口且不溢出。
    assertStep(
      locale,
      "窄视口真实 Dialog 外壳贴合视口减 2rem",
      Math.abs(rect.width - (viewportWidth - 32)) <= 1.5,
      `viewport=${viewportWidth} shell=${rect.width.toFixed(1)} expected=${viewportWidth - 32}`,
    );
    assertStep(
      locale,
      "窄视口内容盒大于 0 且小于外壳",
      contentBox > 0 && contentBox < rect.width,
      `contentBox=${contentBox.toFixed(1)}`,
    );
  }

  assertNoHorizontalScroll(locale, "Dialog 外壳", dialog);
  assertNoHorizontalScroll(locale, "Frimousse 面板根", dialog.querySelector("[frimousse-root]"));
  assertNoHorizontalScroll(
    locale,
    "Frimousse Viewport",
    dialog.querySelector("[frimousse-viewport]"),
  );
  assertNoHorizontalScroll(locale, "Frimousse List", dialog.querySelector("[frimousse-list]"));
  assertStep(
    "global",
    "页面无横向滚动条",
    overflowOf(document.documentElement) <= 1,
    `scrollWidth=${document.documentElement.scrollWidth} clientWidth=${document.documentElement.clientWidth}`,
  );
}

export async function searchLocale(
  locale: LocaleId,
  dialog: HTMLElement,
  query: string,
  label: string,
): Promise<void> {
  const input = await waitFor(
    `[${locale}] 搜索框`,
    () => dialog.querySelector<HTMLInputElement>("input[frimousse-search]"),
    10_000,
  );
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  assertStep(locale, "搜索框支持原生 value setter", Boolean(valueSetter));
  const rowsBefore = dialog.querySelector("[frimousse-list]")?.getAttribute("aria-rowcount") ?? "0";
  assertStep(locale, "搜索前网格有真实行数据", Number(rowsBefore) > 0, `rows=${rowsBefore}`);
  valueSetter!.call(input, query);
  input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  assertStep(locale, `原生 setter 写入搜索词 "${query}"`, input.value === query);

  await waitFor(
    `[${locale}] 搜索 "${query}" 命中 ${label}`,
    () => {
      const rows = dialog.querySelector("[frimousse-list]")?.getAttribute("aria-rowcount") ?? "0";
      // 行数变小证明过滤已生效，避免把搜索前就存在的表情误判为命中。
      return (
        Number(rows) > 0 && Number(rows) < Number(rowsBefore) && findVisibleEmoji(dialog, label)
      );
    },
    15_000,
  );
  assertStep(locale, `搜索 "${query}" 命中可见表情 ${label}`, true);
}

async function assertLocalAssetImage(
  locale: LocaleId,
  label: string,
  image: HTMLImageElement,
): Promise<void> {
  await waitFor(
    `[${locale}] ${label} 图片加载完成`,
    () => image.complete && image.naturalWidth > 0,
    15_000,
  );
  const src = image.currentSrc || image.src;
  assertStep(
    locale,
    `${label} 使用本地 PNG 且 naturalWidth>0`,
    /\/noto-emoji\/emoji_u[0-9a-f_]+\.png$/.test(src) && image.complete && image.naturalWidth > 0,
    `src=${src} naturalWidth=${image.naturalWidth} complete=${image.complete}`,
  );
}

export async function assertSelectedRender(locale: LocaleId): Promise<void> {
  const slot = await waitFor(
    `[${locale}] 选中后的 Tag/ColorMark`,
    () => {
      const element = document.querySelector<HTMLElement>(`[data-testid="${locale}-tag-slot"]`);
      const images = Array.from(element?.querySelectorAll("img") ?? []);
      return element && images.length >= 2 && images.every((image) => image.complete)
        ? element
        : false;
    },
    10_000,
  );
  const images = Array.from(slot.querySelectorAll<HTMLImageElement>("img"));
  // 完整 pill、紧凑圆、分组头颜色圆都应显示本地图片。
  assertStep(
    locale,
    "TaskGroupTag 与 TaskGroupColorMark 均渲染本地图片",
    images.length >= 2,
    `img=${images.length}`,
  );
  for (const image of images) await assertLocalAssetImage(locale, "Tag/ColorMark", image);
  assertStep(
    locale,
    "Tag/ColorMark 不再输出 emoji 字符文本",
    !(slot.textContent ?? "").includes(ROCKET),
    JSON.stringify(slot.textContent),
  );
}

export async function assertUnknownFallback(locale: LocaleId): Promise<void> {
  const slot = document.querySelector<HTMLElement>(`[data-testid="${locale}-fallback-slot"]`);
  assertStep(locale, "未知字符夹具存在", Boolean(slot));
  assertStep(
    locale,
    "未知字符不输出原始 emoji 文本",
    !(slot!.textContent ?? "").includes(UNKNOWN_EMOJI),
    JSON.stringify(slot!.textContent),
  );
  await waitFor(`[${locale}] 未知字符中性图标`, () => slot!.querySelector("svg") ?? false, 10_000);
  assertStep(locale, "未知字符回落到中性本地图标", true);
  assertStep(
    locale,
    "未知字符不请求不存在或系统 emoji 资源",
    slot!.querySelectorAll('img[src*="noto-emoji"], img[src^="http"]').length === 0,
  );
}

export async function assertAssetApi(locale: LocaleId): Promise<void> {
  const image = await waitFor(
    `[${locale}] URL 清单图片`,
    () => document.querySelector<HTMLImageElement>(`[data-testid="${locale}-asset-known"]`),
    10_000,
  );
  await assertLocalAssetImage(locale, "URL 清单 emoji", image);
  const flags = JSON.parse(
    document.querySelector(`[data-testid="${locale}-asset-flags"]`)?.textContent ?? "{}",
  ) as {
    knownAssetUrl?: string | null;
    knownAssetAvailable?: boolean;
    unknownAssetAvailable?: boolean;
  };
  assertStep(
    locale,
    "emojiAssetUrl/hasEmojiAsset 命中本地清单",
    flags.knownAssetAvailable === true &&
      flags.unknownAssetAvailable === false &&
      typeof flags.knownAssetUrl === "string" &&
      flags.knownAssetUrl.endsWith("/noto-emoji/emoji_u1f680.png"),
    JSON.stringify(flags),
  );
}

export { ROCKET };

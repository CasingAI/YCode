import type { Check, Metrics } from "./scenario-types.js";
import {
  appCall,
  measureForced,
  setStyleMarkers,
  settle,
  snapshot,
  split,
  waitSelectOpen,
} from "./scenario-measure.js";

/**
 * 独立生产态浏览器场景：同一套断言分别跑 ESM 与 CJS 入口。
 *
 * 关键区分：
 * - 首次挂载写入（first=true）与实际重挂载后的首次写入是允许的；
 * - 已存在节点在强制重渲染期间的额外写入必须为 0（修复前为 100）；
 * - data-frame 提交记录证明每次重渲染都到达 Viewport，而不是 parent bail；
 * - Select 关闭时 Viewport 位于 detached DocumentFragment，同样纳入统计。
 */

export async function runModeScenarios(
  page: any,
  mode: string,
  check: Check,
  metrics: Metrics,
): Promise<void> {
  await page.waitForFunction(
    () => (window as any).__radixAppReady === true && Boolean((window as any).__radixApp?.snapshot),
    undefined,
    { timeout: 20_000 },
  );
  await settle(page);

  const boot = await snapshot(page);
  metrics.boot = boot;
  check(`${mode}: 生产构建模式`, boot.buildMode === "production", boot.buildMode);
  check(`${mode}: innerHTML 探针可用`, boot.innerHtmlProbe, boot.innerHtmlProbe);
  check(`${mode}: data-frame 探针可用`, boot.frameProbe, boot.frameProbe);
  check(`${mode}: DocumentFragment 探针可用`, boot.fragmentProbe, boot.fragmentProbe);

  // 关闭态：Radix Select 把内容 portal 进 detached DocumentFragment。
  const bootSplit = split(boot.records);
  check(`${mode}: 关闭态 Select Viewport 不在 document`, !boot.selectViewportInDocument, {
    viewport: boot.selectViewportInDocument,
  });
  check(`${mode}: 关闭态 Select 固定样式不在 document`, !boot.selectStyleInDocument, {
    style: boot.selectStyleInDocument,
  });
  check(`${mode}: 关闭态通过 DocumentFragment portal`, boot.fragmentCount >= 1, {
    fragments: boot.fragmentCount,
  });
  check(
    `${mode}: 关闭态首次挂载 Select 样式写入记录`,
    bootSplit.select.some((record) => record.first),
    {
      first: bootSplit.select.filter((record) => record.first).length,
      writes: bootSplit.select.length,
    },
  );
  check(
    `${mode}: 首次挂载 ScrollArea 样式写入记录`,
    bootSplit.scroll.some((record) => record.first),
    {
      first: bootSplit.scroll.filter((record) => record.first).length,
      writes: bootSplit.scroll.length,
    },
  );

  // 关闭态 100 次强制重渲染：Viewport 仍在 fragment 内更新。
  await measureForced(page, `${mode}-closed-forced`, 100, check, metrics);

  // 打开：document 中挂载新的 Viewport 节点，允许其首次写入。
  await appCall(page, "reset", `${mode}-open-mount`);
  await appCall(page, "open", true);
  await waitSelectOpen(page, true);
  await settle(page);
  const opened = await snapshot(page);
  metrics.opened = opened;
  const openedSplit = split(
    opened.records.filter((record) => record.phase === `${mode}-open-mount`),
  );
  check(`${mode}: 打开后 Viewport 在 document`, opened.selectViewportInDocument, {
    viewport: opened.selectViewportInDocument,
  });
  check(`${mode}: 打开后固定样式 nonce 生效`, opened.selectStyleNonce === "nonce-a", {
    nonce: opened.selectStyleNonce,
  });
  check(
    `${mode}: 打开后选项文字完整`,
    ["alpha", "beta", "gamma"].every((option) => opened.selectOptionTexts.includes(option)),
    opened.selectOptionTexts,
  );
  check(
    `${mode}: 打开时 Select 重挂载首次写入分开记录`,
    openedSplit.select.some((record) => record.first),
    {
      first: openedSplit.select.filter((record) => record.first).length,
    },
  );

  await measureForced(page, `${mode}-open-forced`, 100, check, metrics);

  // 受控 value 变化：触发文字立即更新。
  await appCall(page, "setValue", "beta");
  await settle(page);
  const valueChanged = await snapshot(page);
  check(
    `${mode}: value 变化反映到触发文字`,
    valueChanged.selectValue === "beta" && (valueChanged.selectTriggerText ?? "").includes("beta"),
    {
      trigger: valueChanged.selectTriggerText,
      value: valueChanged.selectValue,
    },
  );

  // nonce 变化：复用同一 style 节点，只更新 nonce，不改 CSS 文本。
  await setStyleMarkers(page);
  const beforeNonce = await snapshot(page);
  await appCall(page, "reset", `${mode}-nonce-update`);
  await appCall(page, "setNonce", "nonce-b");
  await settle(page);
  const afterNonce = await snapshot(page);
  const nonceSplit = split(
    afterNonce.records.filter((record) => record.phase === `${mode}-nonce-update`),
  );
  check(`${mode}: nonce 更新到 Select style`, afterNonce.selectStyleNonce === "nonce-b", {
    nonce: afterNonce.selectStyleNonce,
  });
  check(`${mode}: nonce 更新到 ScrollArea style`, afterNonce.scrollStyleNonce === "nonce-b", {
    nonce: afterNonce.scrollStyleNonce,
  });
  check(
    `${mode}: nonce 更新复用 Select style 节点`,
    afterNonce.selectStyleMarker === "keep-select",
    {
      marker: afterNonce.selectStyleMarker,
    },
  );
  check(
    `${mode}: nonce 更新复用 ScrollArea style 节点`,
    afterNonce.scrollStyleMarker === "keep-scroll",
    {
      marker: afterNonce.scrollStyleMarker,
    },
  );
  check(
    `${mode}: nonce 更新不改 CSS 文本`,
    afterNonce.selectStyleText === beforeNonce.selectStyleText &&
      afterNonce.scrollStyleText === beforeNonce.scrollStyleText,
    {
      selectChanged: afterNonce.selectStyleText !== beforeNonce.selectStyleText,
      scrollChanged: afterNonce.scrollStyleText !== beforeNonce.scrollStyleText,
    },
  );
  check(
    `${mode}: nonce 更新不重复写固定样式`,
    nonceSplit.select.length === 0 && nonceSplit.scroll.length === 0,
    {
      select: nonceSplit.select.length,
      scroll: nonceSplit.scroll.length,
    },
  );
  await appCall(page, "setNonce", "nonce-a");
  await settle(page);

  // 键盘：ArrowDown 打开并切换选项，Enter 选择，焦点回到 trigger。
  await appCall(page, "setValue", "alpha");
  await appCall(page, "open", false);
  await waitSelectOpen(page, false);
  await settle(page);
  await page.locator("[data-testid=select-trigger]").focus();
  await page.keyboard.press("ArrowDown");
  await waitSelectOpen(page, true);
  // 等内容完成聚焦再移动，避免键击落在仍在切换焦点的空档。
  await page
    .waitForFunction(
      () => {
        const active = document.activeElement as HTMLElement | null;
        return Boolean(active) && Boolean(active.closest('[role="listbox"]'));
      },
      undefined,
      { timeout: 5_000 },
    )
    .catch(() => {});
  await settle(page, 50);
  await page.keyboard.press("ArrowDown");
  await settle(page, 50);
  await page.keyboard.press("Enter");
  await waitSelectOpen(page, false);
  await settle(page);
  const keyboard = await snapshot(page);
  check(
    `${mode}: 键盘选择更新 value`,
    keyboard.selectValue === "beta" && (keyboard.selectTriggerText ?? "").includes("beta"),
    {
      trigger: keyboard.selectTriggerText,
      value: keyboard.selectValue,
    },
  );
  const focusReturned = await page
    .waitForFunction(
      () => document.activeElement?.getAttribute("data-testid") === "select-trigger",
      undefined,
      { timeout: 5_000 },
    )
    .then(() => true)
    .catch(() => false);
  check(`${mode}: 键盘关闭后焦点回到 trigger`, focusReturned, { focusReturned });

  // 实际重挂载：新节点首次写入允许；重挂载后再次强制渲染仍为 0 额外写入。
  await appCall(page, "reset", `${mode}-scroll-remount`);
  await appCall(page, "remountScroll");
  await settle(page);
  const remounted = await snapshot(page);
  const remountSplit = split(
    remounted.records.filter((record) => record.phase === `${mode}-scroll-remount`),
  );
  const previousScrollIds = new Set((metrics[`${mode}-open-forced`] as any)?.scroll?.ids ?? []);
  check(
    `${mode}: ScrollArea 重挂载产生新的首次写入`,
    remountSplit.scroll.some((record) => record.first),
    {
      first: remountSplit.scroll.filter((record) => record.first).length,
    },
  );
  check(
    `${mode}: ScrollArea 重挂载使用新节点`,
    remountSplit.scroll.every((record) => !previousScrollIds.has(record.id)),
    { ids: remountSplit.scroll.map((record) => record.id) },
  );
  await measureForced(page, `${mode}-remount-forced`, 20, check, metrics);

  // 内容/尺寸/滚动：更新后仍按原语义测量和滚动。
  await settle(page, 150);
  const scrollBefore = await snapshot(page);
  check(`${mode}: ScrollArea 内容溢出`, scrollBefore.scrollHeight > scrollBefore.clientHeight, {
    clientHeight: scrollBefore.clientHeight,
    scrollHeight: scrollBefore.scrollHeight,
  });
  check(
    `${mode}: ScrollArea 滚动条拇指可见`,
    scrollBefore.scrollThumbState === "visible" && scrollBefore.scrollThumbHeight > 0,
    {
      height: scrollBefore.scrollThumbHeight,
      state: scrollBefore.scrollThumbState,
    },
  );
  const scrollTop = await appCall(page, "setScrollTop", 80);
  await settle(page);
  check(`${mode}: ScrollArea scrollTop 生效`, Number(scrollTop) >= 79 && Number(scrollTop) <= 81, {
    scrollTop,
  });

  await appCall(page, "reset", `${mode}-scroll-content-grow`);
  await appCall(page, "setScrollCount", 80);
  await page
    .waitForFunction(
      (before: number) =>
        (document.querySelector("[data-radix-scroll-area-viewport]") as HTMLElement | null)
          ?.scrollHeight > before,
      scrollBefore.scrollHeight,
      { timeout: 5_000 },
    )
    .catch(() => {});
  await settle(page, 150);
  const grown = await snapshot(page);
  const growSplit = split(
    grown.records.filter((record) => record.phase === `${mode}-scroll-content-grow`),
  );
  check(
    `${mode}: ScrollArea 内容增加后 scrollHeight 更新`,
    grown.scrollHeight > scrollBefore.scrollHeight,
    {
      after: grown.scrollHeight,
      before: scrollBefore.scrollHeight,
    },
  );
  check(`${mode}: ScrollArea 内容更新不重复写固定样式`, growSplit.scroll.length === 0, {
    writes: growSplit.scroll.length,
  });

  await appCall(page, "setScrollCount", 3);
  await page
    .waitForFunction(
      () => {
        const viewport = document.querySelector(
          "[data-radix-scroll-area-viewport]",
        ) as HTMLElement | null;
        return Boolean(viewport) && viewport.scrollHeight <= viewport.clientHeight;
      },
      undefined,
      { timeout: 5_000 },
    )
    .catch(() => {});
  await settle(page, 200);
  const shrunk = await snapshot(page);
  check(`${mode}: ScrollArea 内容减少后不再溢出`, shrunk.scrollHeight <= shrunk.clientHeight, {
    clientHeight: shrunk.clientHeight,
    scrollHeight: shrunk.scrollHeight,
  });
  check(`${mode}: ScrollArea 内容减少后隐藏拇指`, shrunk.scrollThumbState === null, {
    state: shrunk.scrollThumbState,
  });

  // 关闭/重开循环不重建 DocumentFragment，且 fragment 内内容保持完整。
  await appCall(page, "open", true);
  await waitSelectOpen(page, true);
  await settle(page);
  const beforeCycle = await snapshot(page);
  check(
    `${mode}: 重开后选项仍完整`,
    ["alpha", "beta", "gamma"].every((option) => beforeCycle.selectOptionTexts.includes(option)),
    beforeCycle.selectOptionTexts,
  );
  await appCall(page, "open", false);
  await waitSelectOpen(page, false);
  await settle(page);
  await appCall(page, "open", true);
  await waitSelectOpen(page, true);
  await settle(page);
  const afterCycle = await snapshot(page);
  check(
    `${mode}: 开关循环不重建 DocumentFragment`,
    afterCycle.fragmentCount === beforeCycle.fragmentCount,
    {
      after: afterCycle.fragmentCount,
      before: beforeCycle.fragmentCount,
    },
  );
}

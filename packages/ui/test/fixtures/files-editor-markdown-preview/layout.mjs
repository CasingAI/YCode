import { TITLE_READABLE_MIN_WIDTH } from "./constants.mjs";

/**
 * 标签条 / Markdown Header 布局探针与断言。
 * 宽度、溢出、控件命中与文档顺序都从真实 DOM 读取，不在夹具里猜生产布局。
 */

export async function layoutMetrics(page, groupId) {
  return page.evaluate((targetGroupId) => {
    const pane = document.querySelector(`[data-editor-group-id="${CSS.escape(targetGroupId)}"]`);
    if (!pane) return { error: `missing pane ${targetGroupId}` };
    const tablist = pane.querySelector('[role="tablist"]');
    if (!(tablist instanceof HTMLElement)) return { error: "missing tablist" };
    const rect = (element) => {
      if (!(element instanceof HTMLElement)) return null;
      const value = element.getBoundingClientRect();
      return {
        left: value.left,
        right: value.right,
        top: value.top,
        bottom: value.bottom,
        width: value.width,
        height: value.height,
      };
    };
    // 控件中心点的命中测试：被覆盖或移出视口时即使有尺寸也不可点。
    const hitInfo = (element) => {
      if (!(element instanceof HTMLElement)) return { ok: false, target: null };
      const value = element.getBoundingClientRect();
      if (value.width <= 0 || value.height <= 0) return { ok: false, target: null };
      const x = value.left + value.width / 2;
      const y = value.top + value.height / 2;
      const top = document.elementFromPoint(x, y);
      return {
        ok: Boolean(top && element.contains(top)),
        target:
          top instanceof HTMLElement
            ? `${top.tagName.toLowerCase()}.${String(top.className).slice(0, 120)}`
            : null,
        point: { x, y },
      };
    };
    // 标签容器是实际裁切边界：标签按最小宽度横向滚动，子节点矩形可以超出容器。
    const containerRect = rect(tablist.firstElementChild);
    const visible = (inner, outer) => {
      if (!inner || !outer) return 0;
      return Math.max(0, Math.min(inner.right, outer.right) - Math.max(inner.left, outer.left));
    };
    const buttonLabel = (element) =>
      `${element.getAttribute("aria-label") ?? ""} ${element.getAttribute("title") ?? ""}`;
    const tabs = Array.from(tablist.querySelectorAll('[role="tab"][data-editor-view-id]')).map(
      (element) => {
        const tabRect = rect(element);
        const titleRect = rect(element.querySelector("span.min-w-0"));
        const tabHit = hitInfo(element);
        return {
          ...tabRect,
          visibleWidth: visible(tabRect, containerRect),
          selected: element.getAttribute("aria-selected") === "true",
          label: (element.textContent ?? "").trim(),
          titleWidth: titleRect?.width ?? null,
          visibleTitleWidth: visible(titleRect, containerRect),
          iconWidth: rect(element.querySelector("svg, img"))?.width ?? null,
          hit: tabHit.ok,
          hitTarget: tabHit.target,
        };
      },
    );
    const switchElement = pane.querySelector("[data-files-markdown-mode-switch]");
    // Header 定位：优先生产显式钩子；没有钩子时退回切换控件的直接父级（Header 包装层）。
    // 两种方式都只读取真实 DOM，不在夹具复制生产布局。
    const headerElement = (() => {
      const explicit = switchElement?.closest(
        "[data-files-markdown-header], [data-files-markdown-mode-header]",
      );
      if (explicit instanceof HTMLElement) return explicit;
      const parent = switchElement?.parentElement;
      return parent instanceof HTMLElement ? parent : null;
    })();
    const modeButtons = Array.from(
      (headerElement ?? pane).querySelectorAll("[data-files-markdown-mode]"),
    ).map((element) => {
      const buttonRect = rect(element);
      const innerText = (element.innerText ?? "").trim();
      return {
        mode: element.getAttribute("data-files-markdown-mode"),
        text: innerText || (element.textContent ?? "").trim(),
        ariaLabel: element.getAttribute("aria-label") ?? "",
        ...buttonRect,
        // 只显示图标的窄组会让文字为空；文字被容器裁切时 scrollWidth 大于 clientWidth。
        textClipped: element.scrollWidth > element.clientWidth + 1,
        visible: Boolean(buttonRect && buttonRect.width > 0 && buttonRect.height > 0),
        hit: hitInfo(element).ok,
      };
    });
    // 标签条右簇（保存 / 分屏）内不得再出现 Markdown 模式控件。
    const tabbarRightCluster = tablist.lastElementChild;
    const tabbarModeCount = tablist.querySelectorAll(
      "[data-files-markdown-mode-switch], [data-files-markdown-mode]",
    ).length;
    const tabbarRightClusterHasMode = Boolean(
      tabbarRightCluster?.querySelector(
        "[data-files-markdown-mode-switch], [data-files-markdown-mode]",
      ),
    );
    // 正文锚点：预览优先，其次源码编辑器（stub）。Header 必须排在它前面且不覆盖它。
    const bodyElement =
      pane.querySelector("[data-files-markdown-preview]") ??
      pane.querySelector('[data-testid="files-e2e-source-editor"]');
    const firstContentElement =
      (bodyElement instanceof HTMLElement ? bodyElement.firstElementChild : null) ?? bodyElement;
    const follows = (first, second) =>
      first instanceof Node && second instanceof Node
        ? Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING)
        : false;
    const saveElement = pane.querySelector("[data-e2e-save-button]");
    const splitElements = Array.from(pane.querySelectorAll("button")).filter((element) => {
      if (element.closest('[role="tab"]')) return false;
      return /拆分|分屏|split/i.test(buttonLabel(element));
    });
    const switchHitInfo = hitInfo(switchElement);
    const saveHitInfo = hitInfo(saveElement);
    const colorLuminance = (value) => {
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");
      if (!context) return null;
      context.fillStyle = "#000000";
      context.fillStyle = value;
      const resolved = context.fillStyle;
      let numbers;
      if (resolved.startsWith("#")) {
        numbers = [
          parseInt(resolved.slice(1, 3), 16) / 255,
          parseInt(resolved.slice(3, 5), 16) / 255,
          parseInt(resolved.slice(5, 7), 16) / 255,
        ];
      } else if (resolved.startsWith("color(")) {
        // color(srgb ...) 的分量已经是 0..1，不能再按 0..255 归一。
        numbers = (resolved.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
      } else if (resolved.startsWith("oklch(") || resolved.startsWith("oklab(")) {
        return null;
      } else {
        numbers = (resolved.match(/[\d.]+/g) ?? []).slice(0, 3).map((part) => Number(part) / 255);
      }
      if (numbers.length < 3 || numbers.some((part) => !Number.isFinite(part))) return null;
      const [r, g, b] = numbers.map((part) =>
        part <= 0.04045 ? part / 12.92 : ((part + 0.055) / 1.055) ** 2.4,
      );
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const style = getComputedStyle(tablist);
    const appElement = pane.closest(".files-e2e-app");
    const appStyle = appElement instanceof HTMLElement ? getComputedStyle(appElement) : undefined;
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      dark: document.documentElement.classList.contains("dark"),
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      bodyOverflow: document.body.scrollWidth - document.documentElement.clientWidth,
      tablist: rect(tablist),
      tabsContainer: containerRect,
      tablistOverflow: tablist.scrollWidth - tablist.clientWidth,
      tabsContainerScrollLeft:
        tablist.firstElementChild instanceof HTMLElement
          ? tablist.firstElementChild.scrollLeft
          : null,
      tabs,
      switchRect: rect(switchElement),
      switchHit: switchHitInfo.ok,
      switchHitTarget: switchHitInfo.target,
      switchInTabList: Boolean(switchElement?.closest('[role="tablist"]')),
      headerRect: rect(headerElement),
      headerInTabList: Boolean(headerElement?.closest('[role="tablist"]')),
      headerContainsSwitch: Boolean(
        headerElement && switchElement && headerElement.contains(switchElement),
      ),
      headerText: headerElement ? (headerElement.innerText ?? "").trim() : "",
      headerOverflow:
        headerElement instanceof HTMLElement
          ? headerElement.scrollWidth - headerElement.clientWidth
          : null,
      tabbarRightClusterRect: rect(tabbarRightCluster),
      tabbarRightClusterHasMode,
      tabbarModeCount,
      modeButtons,
      bodyRect: rect(bodyElement),
      firstContentRect: rect(firstContentElement),
      documentOrder: {
        tablistBeforeHeader: follows(tablist, headerElement),
        headerBeforeBody: follows(headerElement, bodyElement),
      },
      saveRect: rect(saveElement),
      saveHit: saveHitInfo.ok,
      saveHitTarget: saveHitInfo.target,
      splitRects: splitElements.map(rect),
      bodyLuminance: colorLuminance(getComputedStyle(document.body).backgroundColor),
      bodyBackground: getComputedStyle(document.body).backgroundColor,
      appBackground: appStyle?.backgroundColor,
      appLuminance: appStyle ? colorLuminance(appStyle.backgroundColor) : null,
      tablistBackgroundLuminance: colorLuminance(style.backgroundColor),
      tablistBackground: style.backgroundColor,
      tablistForegroundLuminance: colorLuminance(style.color),
    };
  }, groupId);
}

export function isInside(inner, outer) {
  if (!inner || !outer) return false;
  return (
    inner.left >= outer.left - 0.5 &&
    inner.right <= outer.right + 0.5 &&
    inner.top >= outer.top - 0.5 &&
    inner.bottom <= outer.bottom + 0.5
  );
}

/**
 * Header 基础几何：不在标签条内、位于标签条下方正文上方、切换控件在 Header 内、
 * 标签条右簇不含模式控件。任何宽度都适用，不依赖紧凑图标。
 */
export function checkMarkdownHeaderGeometry(check, name, metrics) {
  const header = metrics.headerRect;
  const tablist = metrics.tablist;
  const body = metrics.bodyRect;
  check(
    `${name}: Markdown Header 存在且有尺寸`,
    Boolean(header && header.width > 0 && header.height > 0),
    { header },
  );
  check(
    `${name}: 模式切换不在标签条内`,
    metrics.switchInTabList === false && metrics.headerInTabList === false,
    {
      switchInTabList: metrics.switchInTabList,
      headerInTabList: metrics.headerInTabList,
      switchRect: metrics.switchRect,
    },
  );
  check(
    `${name}: Header 位于标签条下方，不占用标签行`,
    Boolean(header && tablist) && header.top >= tablist.bottom - 0.5,
    { header, tablist },
  );
  check(
    `${name}: Header 位于正文上方且不覆盖正文`,
    Boolean(header && body) && header.bottom <= body.top + 0.5,
    { header, body },
  );
  check(
    `${name}: 模式切换完整位于 Header 内`,
    metrics.headerContainsSwitch === true && isInside(metrics.switchRect, header),
    { header, switchRect: metrics.switchRect, contains: metrics.headerContainsSwitch },
  );
  check(
    `${name}: DOM 顺序为标签条→Header→正文`,
    metrics.documentOrder?.tablistBeforeHeader === true &&
      metrics.documentOrder?.headerBeforeBody === true,
    metrics.documentOrder,
  );
  check(
    `${name}: 标签条右簇不含源码/预览控件`,
    metrics.tabbarModeCount === 0 && metrics.tabbarRightClusterHasMode === false,
    {
      tabbarModeCount: metrics.tabbarModeCount,
      tabbarRightClusterHasMode: metrics.tabbarRightClusterHasMode,
      tabbarRightCluster: metrics.tabbarRightClusterRect,
    },
  );
  check(`${name}: Header 无横向溢出`, (metrics.headerOverflow ?? 0) <= 1, {
    headerOverflow: metrics.headerOverflow,
    header,
  });
  check(
    `${name}: Header 不遮挡正文第一行`,
    Boolean(header && metrics.firstContentRect) &&
      metrics.firstContentRect.top >= header.bottom - 0.5,
    { header, firstContent: metrics.firstContentRect },
  );
}

/**
 * Header 文字断言：两个模式段都必须显示真实文字（不能退化为纯图标），
 * 窄组也不能把文字裁切，并包含调用方要求的可见文案。
 */
export function checkMarkdownHeaderText(check, name, metrics, expectedTexts = []) {
  const buttons = metrics.modeButtons ?? [];
  check(
    `${name}: Header 两个模式段都显示文字而非纯图标`,
    buttons.length === 2 &&
      buttons.every((button) => button.text.length > 0 && button.visible && button.hit),
    buttons,
  );
  check(
    `${name}: Header 模式文字未被裁切`,
    buttons.length === 2 &&
      buttons.every((button) => button.textClipped === false && button.width >= 24),
    buttons,
  );
  for (const text of expectedTexts) {
    check(`${name}: Header 可见文字包含「${text}」`, metrics.headerText.includes(text), {
      expected: text,
      headerText: metrics.headerText,
    });
  }
}

/** 组合几何与文字断言，避免各场景重复两段调用。 */
export function checkMarkdownHeader(check, name, metrics, expectedTexts = []) {
  checkMarkdownHeaderGeometry(check, name, metrics);
  checkMarkdownHeaderText(check, name, metrics, expectedTexts);
}

/** 非 Markdown / 大文本：Header 与模式控件都不应出现在 DOM 中。 */
export function checkMarkdownHeaderAbsent(check, name, metrics) {
  check(
    `${name}: 不显示 Markdown Header`,
    metrics.headerRect === null && metrics.switchRect === null && metrics.tabbarModeCount === 0,
    {
      headerRect: metrics.headerRect,
      switchRect: metrics.switchRect,
      tabbarModeCount: metrics.tabbarModeCount,
    },
  );
}

/** 源码态与预览态应使用同一个 Header/切换位置，而不是随模式换布局。 */
export function checkHeaderPositionStable(check, name, sourceMetrics, previewMetrics) {
  const sameRect = (left, right) =>
    Boolean(left && right) &&
    Math.abs(left.left - right.left) <= 1 &&
    Math.abs(left.top - right.top) <= 1 &&
    Math.abs(left.width - right.width) <= 1 &&
    Math.abs(left.height - right.height) <= 1;
  check(
    `${name}: 源码与预览态 Header 位置一致`,
    sameRect(sourceMetrics.headerRect, previewMetrics.headerRect),
    { source: sourceMetrics.headerRect, preview: previewMetrics.headerRect },
  );
  check(
    `${name}: 源码与预览态切换控件位置一致`,
    sameRect(sourceMetrics.switchRect, previewMetrics.switchRect),
    { source: sourceMetrics.switchRect, preview: previewMetrics.switchRect },
  );
  check(
    `${name}: 源码与预览态 Header 文字一致`,
    sourceMetrics.headerText === previewMetrics.headerText,
    { source: sourceMetrics.headerText, preview: previewMetrics.headerText },
  );
}

export function checkResponsiveLayout(
  check,
  name,
  metrics,
  expectedTabs,
  { requireSwitch = true, headerTexts = [] } = {},
) {
  check(`${name}: 标签数量为 ${expectedTabs}`, metrics.tabs.length === expectedTabs, metrics.tabs);
  check(
    `${name}: 标签仍有可见宽度，未被右侧控件挤没`,
    metrics.tabs.every((tab) => tab.visibleWidth > 0 && tab.height > 0),
    metrics.tabs,
  );
  check(`${name}: 页面无横向溢出`, metrics.documentOverflow <= 1 && metrics.bodyOverflow <= 1, {
    documentOverflow: metrics.documentOverflow,
    bodyOverflow: metrics.bodyOverflow,
  });
  check(`${name}: 标签条内部无横向溢出`, metrics.tablistOverflow <= 1, {
    tablistOverflow: metrics.tablistOverflow,
    tablist: metrics.tablist,
  });
  if (requireSwitch) {
    checkMarkdownHeaderGeometry(check, name, metrics);
    checkMarkdownHeaderText(check, name, metrics, headerTexts);
  }
  // 标签行只剩保存 / 分屏控件；Markdown 切换已移到下方 Header，不再挤压标签。
  const rightControls = [metrics.saveRect, ...metrics.splitRects].filter(Boolean);
  // 标签区可横向滚动，比较裁切容器与控件边界；没有右侧控件时自然通过。
  check(
    `${name}: 标签与右侧控件不重叠`,
    Boolean(metrics.tabsContainer) &&
      rightControls.every((control) => metrics.tabsContainer.right <= control.left + 0.5),
    { tabsContainer: metrics.tabsContainer, rightControls },
  );
  if (metrics.saveRect) {
    check(`${name}: 保存按钮位于标签条内`, isInside(metrics.saveRect, metrics.tablist), {
      saveRect: metrics.saveRect,
      tablist: metrics.tablist,
    });
  }
}

export function checkActiveTabReadable(check, name, metrics, minWidth = TITLE_READABLE_MIN_WIDTH) {
  const active = metrics.tabs.find((tab) => tab.selected) ?? metrics.tabs[0];
  check(
    `${name}: 活动标签标题保留可读区域（>=${minWidth}px）`,
    Boolean(active) && (active.visibleTitleWidth ?? 0) >= minWidth,
    { activeTab: active, minWidth },
  );
}

/**
 * 横滚后活动标签必须真的回到可视区：标题可读、中心点命中自身、页面不被撑宽。
 * 只看未裁切矩形会被横向滚动容器掩盖，因此这里组合可见宽度与命中测试。
 */
export function checkActiveTabReachable(check, name, metrics, minWidth = TITLE_READABLE_MIN_WIDTH) {
  checkActiveTabReadable(check, name, metrics, minWidth);
  const active = metrics.tabs.find((tab) => tab.selected);
  check(`${name}: 活动标签中心点命中自身`, Boolean(active?.hit), {
    activeTab: active,
    scrollLeft: metrics.tabsContainerScrollLeft,
  });
  check(
    `${name}: 激活后页面无横向溢出`,
    metrics.documentOverflow <= 1 && metrics.bodyOverflow <= 1,
    {
      documentOverflow: metrics.documentOverflow,
      bodyOverflow: metrics.bodyOverflow,
    },
  );
}

export function checkControlClickable(check, name, metrics, base, label) {
  const rect = metrics[`${base}Rect`];
  const hit = metrics[`${base}Hit`];
  check(
    `${name}: ${label}可点击`,
    Boolean(rect && rect.width > 0 && rect.height > 0 && hit === true),
    { rect, hit, hitTarget: metrics[`${base}HitTarget`] },
  );
}

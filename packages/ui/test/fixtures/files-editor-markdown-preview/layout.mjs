import { TITLE_READABLE_MIN_WIDTH } from "./constants.mjs";

/**
 * 标签条布局探针与断言。
 * 宽度、溢出、控件命中都从真实 DOM 读取，不在夹具里猜生产布局。
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

export function checkResponsiveLayout(
  check,
  name,
  metrics,
  expectedTabs,
  { requireSwitch = true } = {},
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
    check(`${name}: 源码/预览控件完整位于标签条内`, isInside(metrics.switchRect, metrics.tablist), {
      switchRect: metrics.switchRect,
      tablist: metrics.tablist,
    });
  }
  const rightControls = [metrics.switchRect, metrics.saveRect, ...metrics.splitRects].filter(
    Boolean,
  );
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

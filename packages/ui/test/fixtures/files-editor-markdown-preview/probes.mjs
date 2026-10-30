/**
 * 页面探针：模式控件扫描、点击、等待与源码编辑器状态读取。
 * 只读写本夹具自己启动的隔离页面 DOM，不接触运行中的 YCode。
 */

function modeHaystack(candidate) {
  return [
    candidate.ariaLabel,
    candidate.title,
    candidate.text,
    candidate.testid,
    candidate.dataMode,
  ]
    .filter(Boolean)
    .join(" ");
}

function matchesMode(candidate, mode) {
  const explicit = String(candidate.dataMode ?? "").toLowerCase();
  if (mode === "preview" && explicit === "preview") return true;
  if (mode === "source" && explicit === "source") return true;
  const hay = modeHaystack(candidate);
  if (mode === "preview") {
    return /(^|[^a-z])(preview|markdown[-_ ]?preview)([^a-z]|$)/i.test(hay) || hay.includes("预览");
  }
  return (
    /(^|[^a-z])(source|markdown[-_ ]?source|code)([^a-z]|$)/i.test(hay) || hay.includes("源码")
  );
}

export async function scanModeControls(page, groupId) {
  return page.evaluate((targetGroupId) => {
    const pane = document.querySelector(`[data-editor-group-id="${CSS.escape(targetGroupId)}"]`);
    if (!pane) return { error: `missing pane ${targetGroupId}` };
    const elements = Array.from(
      pane.querySelectorAll(
        '[data-markdown-mode], [data-editor-markdown-mode], [data-mode], [role="radio"], [role="switch"], [role="tab"], button',
      ),
    );
    const candidates = [];
    for (const element of elements) {
      if (!(element instanceof HTMLElement)) continue;
      const explicitMode =
        element.getAttribute("data-files-markdown-mode") ??
        element.getAttribute("data-markdown-mode") ??
        element.getAttribute("data-editor-markdown-mode") ??
        element.getAttribute("data-mode");
      if (element.closest('[role="tab"][data-editor-view-id]') && !explicitMode) continue;
      if (element.getAttribute("role") === "tab" && element.hasAttribute("data-editor-view-id"))
        continue;
      if (element.hasAttribute("disabled")) continue;
      element.setAttribute("data-e2e-mode-candidate", String(candidates.length));
      candidates.push({
        index: candidates.length,
        ariaLabel: element.getAttribute("aria-label") ?? "",
        title: element.getAttribute("title") ?? "",
        text: (element.textContent ?? "").trim(),
        testid: element.getAttribute("data-testid") ?? "",
        dataMode: explicitMode ?? "",
        pressed: element.getAttribute("aria-pressed") ?? "",
        checked: element.getAttribute("aria-checked") ?? "",
        state: element.getAttribute("data-state") ?? "",
        inTabList: Boolean(element.closest('[role="tablist"]')),
        // 断言失败时保留一小段 DOM，便于区分模式按钮与其他标签条控件。
        html: element.outerHTML.slice(0, 300),
      });
    }
    return { candidates };
  }, groupId);
}

export function pickMode(candidates, mode) {
  return candidates.find((candidate) => matchesMode(candidate, mode));
}

export async function clickCandidate(page, groupId, candidate) {
  const pane = page.locator(`[data-editor-group-id="${groupId}"]`);
  const target = pane.locator(`[data-e2e-mode-candidate="${candidate.index}"]`);
  try {
    await target.click({ timeout: 3000 });
  } catch {
    // 分段控件可能把可点击面放在 label/父级；真实 DOM click 仍能触发同一 React 处理。
    await page.evaluate(
      ({ groupId: id, index }) => {
        const element = document.querySelector(
          `[data-editor-group-id="${CSS.escape(id)}"] [data-e2e-mode-candidate="${index}"]`,
        );
        if (element instanceof HTMLElement) element.click();
      },
      { groupId, index: candidate.index },
    );
  }
}

export async function waitForMode(page, groupId, mode, timeout = 10_000) {
  await page.waitForFunction(
    ({ groupId: id, expectedMode }) => {
      const pane = document.querySelector(`[data-editor-group-id="${CSS.escape(id)}"]`);
      if (!pane) return false;
      const isVisible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        const style = getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden";
      };
      const preview = pane.querySelector("[data-files-markdown-preview]");
      const textarea = pane.querySelector('[data-testid="files-e2e-source-editor"]');
      if (expectedMode === "preview") return isVisible(preview);
      return !preview && isVisible(textarea);
    },
    { groupId, expectedMode: mode },
    { timeout },
  );
}

export async function poll(fn, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await new Promise((resolvePoll) => setTimeout(resolvePoll, 50));
  }
  throw new Error(`等待超时: ${JSON.stringify(last)}`);
}

export async function fillSource(page, groupId, text) {
  const textarea = page.locator(
    `[data-editor-group-id="${groupId}"] [data-testid="files-e2e-source-editor"]`,
  );
  await textarea.waitFor({ state: "visible", timeout: 10_000 });
  await textarea.fill(text);
  await poll(async () => {
    const snapshot = await page.evaluate(() => window.__filesE2E.snapshot());
    return snapshot.buffers.some((buffer) => buffer.text === text);
  });
}

export async function findSaveButton(page, groupId) {
  return page.evaluate((targetGroupId) => {
    const pane = document.querySelector(`[data-editor-group-id="${CSS.escape(targetGroupId)}"]`);
    if (!pane) return undefined;
    const buttons = Array.from(pane.querySelectorAll("button"));
    const button = buttons.find((candidate) => {
      if (candidate.closest('[role="tab"]')) return false;
      const label = `${candidate.getAttribute("aria-label") ?? ""} ${
        candidate.getAttribute("title") ?? ""
      }`;
      return /保存|save/i.test(label);
    });
    if (!button) return undefined;
    button.setAttribute("data-e2e-save-button", "true");
    return { label: button.getAttribute("aria-label") ?? button.getAttribute("title") ?? "" };
  }, groupId);
}

export async function setTheme(page, dark) {
  await page.evaluate((isDark) => {
    document.documentElement.classList.toggle("dark", isDark);
    document.documentElement.classList.toggle("theme-zai-dark", isDark);
  }, dark);
}

export const isPreviewShown = (page, groupId) =>
  page.evaluate((id) => {
    const pane = document.querySelector(`[data-editor-group-id="${CSS.escape(id)}"]`);
    const preview = pane?.querySelector("[data-files-markdown-preview]");
    if (!(preview instanceof HTMLElement)) return false;
    const rect = preview.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && getComputedStyle(preview).display !== "none";
  }, groupId);

export const isSourceShown = async (page, groupId) => {
  if (await isPreviewShown(page, groupId)) return false;
  return page.evaluate((id) => {
    const pane = document.querySelector(`[data-editor-group-id="${CSS.escape(id)}"]`);
    const textarea = pane?.querySelector('[data-testid="files-e2e-source-editor"]');
    if (!(textarea instanceof HTMLElement)) return false;
    const rect = textarea.getBoundingClientRect();
    const style = getComputedStyle(textarea);
    return rect.width > 0 && rect.height > 0 && style.display !== "none";
  }, groupId);
};

export const editorIsInert = (page, groupId) =>
  page.evaluate((id) => {
    const pane = document.querySelector(`[data-editor-group-id="${CSS.escape(id)}"]`);
    const textarea = pane?.querySelector('[data-testid="files-e2e-source-editor"]');
    return Boolean(textarea?.closest("[inert]"));
  }, groupId);

export async function hasModeSwitch(page, groupId) {
  const scanned = await scanModeControls(page, groupId);
  return Boolean(pickMode(scanned.candidates, "source") || pickMode(scanned.candidates, "preview"));
}

/**
 * 记住当前源码编辑器 DOM 节点，稍后比较模式切换前后是否仍是同一个节点。
 * 这是“编辑器保持挂载”的直接证据，比只看撤销栈更严格。
 */
export const captureSourceEditorNode = (page, groupId) =>
  page.evaluate((id) => {
    const pane = document.querySelector(`[data-editor-group-id="${CSS.escape(id)}"]`);
    const textarea = pane?.querySelector('[data-testid="files-e2e-source-editor"]');
    window.__filesE2E.sourceEditorNode = textarea ?? null;
    return Boolean(textarea);
  }, groupId);

export const readSourceEditorNodeState = (page, groupId) =>
  page.evaluate((id) => {
    const pane = document.querySelector(`[data-editor-group-id="${CSS.escape(id)}"]`);
    const textarea = pane?.querySelector('[data-testid="files-e2e-source-editor"]');
    return {
      sameNode: Boolean(textarea) && window.__filesE2E.sourceEditorNode === textarea,
      connected: Boolean(textarea?.isConnected),
      inert: Boolean(textarea?.closest("[inert]")),
      value: textarea instanceof HTMLTextAreaElement ? textarea.value : undefined,
    };
  }, groupId);

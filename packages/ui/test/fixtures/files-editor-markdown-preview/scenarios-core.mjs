import { LARGE_PATH, MD_PATH, MD_SAVED, TXT_PATH } from "./constants.mjs";
import {
  checkControlClickable,
  checkHeaderPositionStable,
  checkMarkdownHeader,
  checkMarkdownHeaderAbsent,
  checkMarkdownHeaderGeometry,
  layoutMetrics,
} from "./layout.mjs";
import {
  captureSourceEditorNode,
  clickCandidate,
  editorIsInert,
  fillSource,
  findSaveButton,
  firstLinePointerState,
  hasModeSwitch,
  isPreviewShown,
  isSourceShown,
  pickMode,
  poll,
  readSourceEditorNodeState,
  scanModeControls,
  waitForMode,
} from "./probes.mjs";

/**
 * Markdown 默认场景：源码 / 预览、草稿、保存、撤销、分屏共享与非 Markdown。
 * 只通过探针读取隔离页面，不操作运行中的 YCode。
 */
export async function runCoreScenarios({ page, check, shot, mount, snapshot, pathInfo }) {
  const handleEventsFor = async (groupId) =>
    (await snapshot()).editorHandleEvents.filter((event) => event.groupId === groupId);

  // ---------------------------------------------------------------- markdown
  await mount("markdown");
  let state = await snapshot();
  const mdGroup = state.groups[0].id;
  await waitForMode(page, mdGroup, "source");
  check("markdown: 打开一个 Markdown 标签", state.groups.length === 1 && state.views.length === 1);
  check(
    "markdown: 初始正文/基准为磁盘内容",
    state.buffers[0]?.text === MD_SAVED && state.buffers[0]?.savedText === MD_SAVED,
    state.buffers[0],
  );
  let controls = await scanModeControls(page, mdGroup);
  const sourceControl = pickMode(controls.candidates, "source");
  const previewControl = pickMode(controls.candidates, "preview");
  check(
    "markdown: 出现源码/预览切换",
    Boolean(sourceControl && previewControl),
    controls.candidates,
  );
  // 本轮位置：切换器在标签条下方的轻量 Header，不在标签行、不占右侧标签空间。
  check(
    "markdown: 切换控件不在标签条内",
    sourceControl?.inTabList === false && previewControl?.inTabList === false,
    { sourceControl, previewControl },
  );
  const sourceHeader = await layoutMetrics(page, mdGroup);
  checkMarkdownHeader(check, "markdown", sourceHeader, ["Markdown", "预览"]);
  check("markdown: 默认源码视图可见编辑器", await isSourceShown(page, mdGroup));
  check("markdown: 记住源码编辑器 DOM 节点", await captureSourceEditorNode(page, mdGroup));
  const firstLine = await firstLinePointerState(page, mdGroup);
  check("markdown: Header 不遮挡正文第一行，第一行可聚焦", firstLine.ok === true, firstLine);
  await shot(page, "00-desktop-light-source-header");

  const initialHandle = await poll(async () => {
    const events = await handleEventsFor(mdGroup);
    return [...events].reverse().find((event) => event.handleId != null);
  }).catch(() => undefined);
  check("handle: 源码态向工作台上报编辑器句柄", Boolean(initialHandle), initialHandle);

  const draftToken = `UNSAVED-DRAFT-${Date.now()}`;
  const draft = `# Guide\n\nSAVED-BODY\n\n${draftToken}`;
  await fillSource(page, mdGroup, draft);
  state = await snapshot();
  check(
    "draft: 编辑进入真实 buffer.text 且 dirty=true",
    state.buffers[0]?.text === draft && state.buffers[0]?.dirty === true,
    state.buffers[0],
  );
  check("draft: 基准正文未被编辑污染", state.buffers[0]?.savedText === MD_SAVED);

  await clickCandidate(page, mdGroup, previewControl);
  await waitForMode(page, mdGroup, "preview");
  const previewHeader = await layoutMetrics(page, mdGroup);
  checkMarkdownHeader(check, "markdown-preview", previewHeader, ["Markdown", "预览"]);
  checkHeaderPositionStable(check, "markdown", sourceHeader, previewHeader);
  check("preview: 预览覆盖层出现", await isPreviewShown(page, mdGroup));
  check("preview: 底层编辑器被 inert 隔离", await editorIsInert(page, mdGroup));
  const previewNode = await readSourceEditorNodeState(page, mdGroup);
  check(
    "preview: 源码编辑器仍是切换前同一 DOM 节点",
    previewNode.sameNode && previewNode.connected,
    previewNode,
  );
  const draftRendered = await poll(async () =>
    page.evaluate((value) => document.body.innerText.includes(value), draftToken),
  )
    .then(() => true)
    .catch(() => false);
  check("preview: 渲染当前未保存草稿", draftRendered);
  state = await snapshot();
  check(
    "preview: 切换不动正文与 dirty",
    state.buffers[0]?.text === draft && state.buffers[0]?.dirty === true,
    state.buffers[0],
  );
  const previewHandle = await poll(async () => {
    const events = await handleEventsFor(mdGroup);
    const last = events.at(-1);
    return last?.handleId === null ? last : undefined;
  }).catch(() => undefined);
  check(
    "preview: 预览态上报的编辑器句柄为 null",
    previewHandle?.handleId === null && previewHandle?.bufferId === state.buffers[0]?.id,
    { previewHandle, events: await handleEventsFor(mdGroup) },
  );
  await shot(page, "01-preview-unsaved-draft");

  await clickCandidate(page, mdGroup, sourceControl);
  await waitForMode(page, mdGroup, "source");
  const restoredNode = await readSourceEditorNodeState(page, mdGroup);
  check(
    "source: 返回后仍是切换前同一 DOM 节点",
    restoredNode.sameNode && restoredNode.connected,
    restoredNode,
  );
  check("source: 返回源码后解除 inert", restoredNode.inert === false, restoredNode);
  check(
    "source: 返回源码后正文草稿仍在",
    (await page
      .locator(`[data-editor-group-id="${mdGroup}"] [data-testid="files-e2e-source-editor"]`)
      .inputValue()) === draft,
  );
  state = await snapshot();
  check(
    "source: 返回后 dirty 仍为 true",
    state.buffers[0]?.text === draft && state.buffers[0]?.dirty === true,
    state.buffers[0],
  );
  const restoredHandle = await poll(async () => {
    const events = await handleEventsFor(mdGroup);
    const lastNull = events.findLastIndex((event) => event.handleId === null);
    return lastNull >= 0
      ? events.slice(lastNull + 1).find((event) => event.handleId != null)
      : undefined;
  }).catch(() => undefined);
  check(
    "source: 返回后重新上报同一编辑器句柄",
    restoredHandle?.handleId != null && restoredHandle.handleId === initialHandle?.handleId,
    { initialHandle, restoredHandle, events: await handleEventsFor(mdGroup) },
  );

  // 撤销发生在模型边界（对应 Monaco model cache）；切换预览没有重建 buffer/模型。
  const editor = page.locator(
    `[data-editor-group-id="${mdGroup}"] [data-testid="files-e2e-source-editor"]`,
  );
  await editor.focus();
  await page.keyboard.press("Control+z");
  await poll(async () => (await snapshot()).buffers[0]?.text === MD_SAVED);
  state = await snapshot();
  check(
    "undo: 切换预览后仍可撤销到已保存正文",
    state.buffers[0]?.text === MD_SAVED && state.buffers[0]?.dirty === false,
    state.buffers[0],
  );
  await page.keyboard.press("Control+Shift+z");
  await poll(async () => (await snapshot()).buffers[0]?.text === draft);
  state = await snapshot();
  check(
    "redo: 撤销后可重做草稿",
    state.buffers[0]?.text === draft && state.buffers[0]?.dirty === true,
  );

  const saveButton = await findSaveButton(page, mdGroup);
  check("save: 脏 Markdown 标签出现保存按钮", Boolean(saveButton), saveButton);
  if (saveButton) {
    const saveMetrics = await layoutMetrics(page, mdGroup);
    checkControlClickable(check, "markdown", saveMetrics, "save", "保存");
    check(
      "markdown: 保存按钮位于 Header 上方，未被 Header 遮挡",
      Boolean(saveMetrics.saveRect && saveMetrics.headerRect) &&
        saveMetrics.saveRect.bottom <= saveMetrics.headerRect.top + 0.5,
      { saveRect: saveMetrics.saveRect, headerRect: saveMetrics.headerRect },
    );
    await page.locator('[data-e2e-save-button="true"]').click();
    await poll(async () => (await snapshot()).saveCalls.length > 0);
    state = await snapshot();
    const call = state.saveCalls[0];
    check(
      "save: 保存的是当前草稿正文",
      call?.bufferId === state.buffers[0]?.id && call?.text === draft,
      call,
    );
    check(
      "save: 保存成功后 dirty 清除且正文不变",
      state.buffers[0]?.text === draft &&
        state.buffers[0]?.savedText === draft &&
        state.buffers[0]?.dirty === false,
      state.buffers[0],
    );
    check("save: 保存后编辑器仍显示草稿", (await editor.inputValue()) === draft);
  }
  await shot(page, "02-source-after-save");

  // ------------------------------------------------------------------- split
  await mount("split");
  state = await snapshot();
  check("split: 两个编辑器组各一个视图", state.groups.length === 2 && state.views.length === 2);
  check(
    "split: 两个视图共享同一 buffer",
    state.views[0]?.bufferId === state.views[1]?.bufferId,
    state.views,
  );
  const splitGroupA = state.groups[0].id;
  const splitGroupB = state.groups[1].id;
  check(
    "split: 两组初始都是源码",
    (await isSourceShown(page, splitGroupA)) && (await isSourceShown(page, splitGroupB)),
  );
  // 每个编辑组各自拥有一个位于标签条下方的 Header；分屏后仍不回到标签行。
  const splitSourceHeaders = new Map();
  for (const [label, groupId] of [
    ["A", splitGroupA],
    ["B", splitGroupB],
  ]) {
    const groupMetrics = await layoutMetrics(page, groupId);
    splitSourceHeaders.set(groupId, groupMetrics);
    checkMarkdownHeader(check, `split-${label}-source`, groupMetrics, ["Markdown", "预览"]);
  }

  let splitDraft = `${MD_SAVED}\n\nSPLIT-DRAFT-${Date.now()}`;
  await fillSource(page, splitGroupA, splitDraft);
  controls = await scanModeControls(page, splitGroupA);
  const splitPreviewA = pickMode(controls.candidates, "preview");
  const splitSourceA = pickMode(controls.candidates, "source");
  check("split: A 组存在切换控件", Boolean(splitPreviewA && splitSourceA), controls.candidates);

  await clickCandidate(page, splitGroupA, splitPreviewA);
  await waitForMode(page, splitGroupA, "preview");
  check(
    "split: A 组预览时 B 组仍是源码",
    (await isPreviewShown(page, splitGroupA)) && (await isSourceShown(page, splitGroupB)),
  );
  const splitPreviewHeaderA = await layoutMetrics(page, splitGroupA);
  checkMarkdownHeaderGeometry(check, "split-A-preview", splitPreviewHeaderA);
  checkHeaderPositionStable(
    check,
    "split-A",
    splitSourceHeaders.get(splitGroupA),
    splitPreviewHeaderA,
  );
  state = await snapshot();
  check(
    "split: A 组切换不影响共享正文/dirty",
    state.buffers[0]?.text === splitDraft && state.buffers[0]?.dirty === true,
    state.buffers[0],
  );

  // 源码侧继续编辑，预览侧直接看到最新 buffer.text；两视图仍只有一个 buffer。
  const splitSyncToken = `SPLIT-SYNC-${Date.now()}`;
  splitDraft = `${splitDraft}\n\n${splitSyncToken}`;
  await fillSource(page, splitGroupB, splitDraft);
  const syncedPreview = await poll(async () =>
    page.evaluate((value) => document.body.innerText.includes(value), splitSyncToken),
  )
    .then(() => true)
    .catch(() => false);
  check("split: 源码侧编辑后预览侧渲染最新正文", syncedPreview);
  state = await snapshot();
  check(
    "split: 两侧仍共享同一个真实 buffer",
    state.buffers.length === 1 &&
      state.views.length === 2 &&
      state.views.every((view) => view.bufferId === state.buffers[0]?.id),
    { buffers: state.buffers, views: state.views },
  );
  check(
    "split: 源码侧编辑同步到共享正文与 dirty",
    state.buffers[0]?.text === splitDraft && state.buffers[0]?.dirty === true,
    state.buffers[0],
  );

  controls = await scanModeControls(page, splitGroupB);
  const splitPreviewB = pickMode(controls.candidates, "preview");
  check("split: B 组有独立切换控件", Boolean(splitPreviewB), controls.candidates);
  if (splitPreviewB) {
    await clickCandidate(page, splitGroupB, splitPreviewB);
    await waitForMode(page, splitGroupB, "preview");
    check(
      "split: 两组可同时预览",
      (await isPreviewShown(page, splitGroupA)) && (await isPreviewShown(page, splitGroupB)),
    );
    await clickCandidate(page, splitGroupA, splitSourceA);
    await waitForMode(page, splitGroupA, "source");
    check(
      "split: A 回到源码时 B 保持预览",
      (await isSourceShown(page, splitGroupA)) && (await isPreviewShown(page, splitGroupB)),
    );
    state = await snapshot();
    check(
      "split: 多次按视图切换后正文/dirty 不变",
      state.buffers[0]?.text === splitDraft && state.buffers[0]?.dirty === true,
      state.buffers[0],
    );
    await shot(page, "03-split-independent-views");
  }

  // ------------------------------------------------------------------- mixed
  await mount("mixed");
  state = await snapshot();
  const txtView = await pathInfo(TXT_PATH);
  const mdView = await pathInfo(MD_PATH);
  check(
    "mixed: 活动标签是 txt",
    Boolean(txtView.groupId) &&
      state.groups.find((group) => group.id === txtView.groupId)?.activeViewId === txtView.viewId,
    { txtView, groups: state.groups },
  );
  check(
    "mixed: 非 Markdown 活动标签不显示切换控件",
    (await hasModeSwitch(page, txtView.groupId)) === false,
    (await scanModeControls(page, txtView.groupId)).candidates,
  );
  const mixedTxtMetrics = await layoutMetrics(page, txtView.groupId);
  checkMarkdownHeaderAbsent(check, "mixed-txt", mixedTxtMetrics);

  await page.evaluate(
    ({ groupId, viewId }) => {
      const tab = document.querySelector(
        `[data-editor-group-id="${CSS.escape(groupId)}"] [data-editor-view-id="${CSS.escape(viewId)}"]`,
      );
      if (!(tab instanceof HTMLElement)) throw new Error("missing md tab");
      tab.click();
    },
    { groupId: mdView.groupId, viewId: mdView.viewId },
  );
  await poll(async () => {
    const next = await scanModeControls(page, mdView.groupId);
    return pickMode(next.candidates, "preview");
  });
  check("mixed: 切到 Markdown 标签后出现切换控件", true);
  const mixedMdMetrics = await layoutMetrics(page, mdView.groupId);
  checkMarkdownHeader(check, "mixed-md", mixedMdMetrics, ["Markdown", "预览"]);

  controls = await scanModeControls(page, mdView.groupId);
  const mixedPreview = pickMode(controls.candidates, "preview");
  await clickCandidate(page, mdView.groupId, mixedPreview);
  await waitForMode(page, mdView.groupId, "preview");

  await page.evaluate(
    ({ groupId, viewId }) => {
      const tab = document.querySelector(
        `[data-editor-group-id="${CSS.escape(groupId)}"] [data-editor-view-id="${CSS.escape(viewId)}"]`,
      );
      if (!(tab instanceof HTMLElement)) throw new Error("missing txt tab");
      tab.click();
    },
    { groupId: txtView.groupId, viewId: txtView.viewId },
  );
  await new Promise((resolveWait) => setTimeout(resolveWait, 300));
  const afterTxtClick = await snapshot();
  const afterTxtControls = await scanModeControls(page, txtView.groupId);
  check(
    "mixed: 切到 txt 后活动视图更新",
    afterTxtClick.groups.find((group) => group.id === txtView.groupId)?.activeViewId ===
      txtView.viewId,
    { afterTxtClick, afterTxtControls },
  );
  await poll(async () => (await hasModeSwitch(page, txtView.groupId)) === false);
  check("mixed: 切到 txt 后切换控件消失", true);
  await poll(async () => (await layoutMetrics(page, txtView.groupId)).headerRect === null);
  check("mixed: 切到 txt 后 Markdown Header 消失", true);

  await page.evaluate(
    ({ groupId, viewId }) => {
      const tab = document.querySelector(
        `[data-editor-group-id="${CSS.escape(groupId)}"] [data-editor-view-id="${CSS.escape(viewId)}"]`,
      );
      if (!(tab instanceof HTMLElement)) throw new Error("missing md tab again");
      tab.click();
    },
    { groupId: mdView.groupId, viewId: mdView.viewId },
  );
  await poll(async () => (await isPreviewShown(page, mdView.groupId)) === true);
  check("mixed: 回到 Markdown 标签仍保持该视图的预览模式", true);
  const mixedBackMetrics = await layoutMetrics(page, mdView.groupId);
  checkMarkdownHeaderGeometry(check, "mixed-md-back", mixedBackMetrics);
  await shot(page, "04-mixed-non-markdown");

  // ------------------------------------------------------------------- large
  await mount("large");
  state = await snapshot();
  const largeInfo = await pathInfo(LARGE_PATH);
  const largeBuffer = state.buffers.find((buffer) => buffer.path === LARGE_PATH);
  check("large: 活动标签是大文本 .md", largeBuffer?.kind === "large-text", largeBuffer);
  check(
    "large: 大文本不显示切换控件",
    (await hasModeSwitch(page, largeInfo.groupId)) === false,
    (await scanModeControls(page, largeInfo.groupId)).candidates,
  );
  const largeMetrics = await layoutMetrics(page, largeInfo.groupId);
  checkMarkdownHeaderAbsent(check, "large", largeMetrics);
  check(
    "large: 渲染大文本查看器边界",
    (await page.locator('[data-testid="files-e2e-large-text-viewer"]').count()) === 1,
  );
  const largeMdView = await pathInfo(MD_PATH);
  await page.evaluate(
    ({ groupId, viewId }) => {
      const tab = document.querySelector(
        `[data-editor-group-id="${CSS.escape(groupId)}"] [data-editor-view-id="${CSS.escape(viewId)}"]`,
      );
      if (tab instanceof HTMLElement) tab.click();
    },
    { groupId: largeMdView.groupId, viewId: largeMdView.viewId },
  );
  await poll(async () => {
    const next = await scanModeControls(page, largeMdView.groupId);
    return pickMode(next.candidates, "preview");
  });
  check("large: 同组普通 Markdown 标签仍有切换控件", true);
  const largeMdMetrics = await layoutMetrics(page, largeMdView.groupId);
  checkMarkdownHeaderGeometry(check, "large-md", largeMdMetrics);
  await shot(page, "05-large-text-no-toggle");
}

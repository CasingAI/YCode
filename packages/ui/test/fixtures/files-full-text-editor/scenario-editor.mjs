import { LEGACY_BLOCK_STEP, LEGACY_LARGE_FILE_BYTES, TOKENS } from "./constants.mjs";

/**
 * 打开 / 完整模型 / 跨边界搜索 / Ctrl+End / 跨旧块编辑与撤销重做。
 *
 * 所有断言都作用在生产 Store 与真实 Monaco 模型上；键盘操作是真实事件。
 * 返回保存场景需要的「编辑前边界行文本」与编辑后完整长度。
 */
export async function runEditorScenarios(ctx) {
  const {
    page,
    confirm,
    waitFor,
    shot,
    mount,
    openPath,
    activeTextBuffer,
    monacoInfo,
    bufferTokens,
    editorSnapshot,
    focusEditor,
    meta,
  } = ctx;

  // ---------------------------------------------------------------- 打开
  await page.evaluate(() => window.__fullTextE2E.clearStorage());
  await mount("fresh");
  await openPath();
  const opened = await waitFor(
    async () => {
      const buffer = await activeTextBuffer();
      return buffer && buffer.textLength === meta.totalBytes ? buffer : undefined;
    },
    "生产读取决策返回完整正文",
    60_000,
  );
  confirm("open: 缓冲是完整文本而不是 large-text", opened.kind === "text", opened);
  confirm(
    "open: 完整正文长度等于磁盘总字节数（未在 256 KiB / 8 MiB 处截断）",
    opened.textLength === meta.totalBytes,
    { textLength: opened.textLength, totalBytes: meta.totalBytes },
  );
  confirm("open: 打开后写入 diskVersion", typeof opened.diskVersion === "string", opened);
  confirm("open: 正文以 JSON 数组开头", opened.head?.startsWith("["), opened.head);

  const model = await waitFor(
    async () => {
      const info = await monacoInfo([]);
      return info && info.lineCount === meta.lineCount ? info : undefined;
    },
    "真实 Monaco 模型加载完整正文",
    90_000,
  );
  confirm(
    "model: Monaco 模型值长度等于 10174816",
    model.valueLength === meta.totalBytes,
    { valueLength: model.valueLength, totalBytes: meta.totalBytes },
  );
  confirm("model: Monaco 行号覆盖完整 395602 行", model.lineCount === meta.lineCount, {
    lineCount: model.lineCount,
  });
  confirm("model: 首行是 [", model.firstLine === "[", model.firstLine);
  confirm("model: 末行是 ]", model.lastLine === "]", model.lastLine);
  await shot("01-open-full-model");

  // ------------------------------------------------- 全文搜索（跨旧边界）
  const searched = await monacoInfo(
    [TOKENS.boundaryLeft, TOKENS.boundaryRight, TOKENS.pastEightMiB, TOKENS.tail],
    [meta.boundary.lineNumber],
  );
  const tokenMatch = (token) => searched?.tokens.find((entry) => entry.token === token);
  const leftMatch = tokenMatch(TOKENS.boundaryLeft);
  const rightMatch = tokenMatch(TOKENS.boundaryRight);
  const pastMatch = tokenMatch(TOKENS.pastEightMiB);
  const tailMatch = tokenMatch(TOKENS.tail);
  confirm(
    "search: 262140 边界两侧 token 在完整 model 中各命中 1 次",
    leftMatch?.count === 1 && rightMatch?.count === 1,
    searched?.tokens,
  );
  confirm(
    "search: 左 token 命中偏移早于 262140，右 token 不早于 262140",
    (leftMatch?.positions[0]?.offset ?? -1) < LEGACY_BLOCK_STEP &&
      (rightMatch?.positions[0]?.offset ?? -1) >= LEGACY_BLOCK_STEP,
    { left: leftMatch?.positions, right: rightMatch?.positions },
  );
  confirm(
    "search: 旧 8 MiB 之后的 token 在完整 model 中命中",
    pastMatch?.count === 1 && (pastMatch.positions[0]?.offset ?? -1) > LEGACY_LARGE_FILE_BYTES,
    pastMatch,
  );
  confirm(
    "search: 尾部 marker 命中最后一行数据行",
    tailMatch?.count === 1 && tailMatch.positions[0]?.line === meta.tail.lineNumber,
    tailMatch,
  );
  confirm(
    "search: 边界行的真实行文本同时包含左右 token",
    Boolean(
      searched?.lineTexts[0]?.text.includes(TOKENS.boundaryLeft) &&
        searched.lineTexts[0]?.text.includes(TOKENS.boundaryRight),
    ),
    searched?.lineTexts,
  );

  // 真实 Ctrl+F：确认编辑器查找 UI 作用于完整 Monaco 模型，而不是旧 262140 块。
  // 先经 Monaco 公开 API 聚焦真实编辑器，再发送真实键盘事件。
  if (!(await focusEditor())) {
    throw new Error("无法聚焦真实 Monaco 编辑器");
  }
  await page.keyboard.press("Control+f");
  // find widget 一直在 DOM 中，只有打开时才带 visible 类；必须等它真正展开。
  const findWidget = page.locator(".monaco-editor .find-widget.visible").first();
  try {
    await findWidget.waitFor({ state: "visible", timeout: 10_000 });
  } catch (error) {
    const state = await page.evaluate(() => {
      const active = document.activeElement;
      return {
        activeTag: active?.tagName,
        activeClass: active?.className,
        widgets: [...document.querySelectorAll(".find-widget")].map((widget) => ({
          className: widget.className,
          visible: widget.classList.contains("visible"),
          rect: widget.getBoundingClientRect().toJSON(),
        })),
      };
    });
    throw new Error(`Ctrl+F 未打开查找控件: ${JSON.stringify(state)}; ${error}`);
  }
  // Monaco 查找输入框是自适应高度的 textarea（flexibleHeight），不是单行 input。
  const findInput = findWidget.locator(".monaco-findInput textarea").first();
  await findInput.waitFor({ state: "visible", timeout: 10_000 });
  await page.keyboard.type(TOKENS.pastEightMiB);
  await waitFor(
    async () => (await findInput.inputValue()) === TOKENS.pastEightMiB,
    "Ctrl+F 输入 8 MiB 之后的 token",
    10_000,
  );
  const matchesCount = await findWidget
    .locator(".matchesCount")
    .first()
    .innerText()
    .catch(() => "");
  confirm(
    "search: Ctrl+F 查找控件可见且接受 8 MiB 之后的 token",
    (await findWidget.isVisible()) === true,
  );
  if (/\d/.test(matchesCount)) {
    confirm("search: Ctrl+F 显示命中计数", /1/.test(matchesCount), matchesCount);
  }
  await shot("02-ctrl-f-search-past-8mib");
  await page.keyboard.press("Escape");

  // ------------------------------------------------------------ Ctrl+End
  if (!(await focusEditor())) {
    throw new Error("无法重新聚焦真实 Monaco 编辑器");
  }
  await page.keyboard.press("Control+End");
  const endSnapshot = await waitFor(
    async () => {
      const current = await editorSnapshot();
      return current && current.lineNumber === meta.lineCount ? current : undefined;
    },
    "Ctrl+End 到达文件尾",
    15_000,
  );
  confirm(
    "ctrl+end: 光标落在最后一行（395602）",
    endSnapshot.lineNumber === meta.lineCount,
    endSnapshot,
  );
  confirm("ctrl+end: 最后一行是 JSON 数组结尾 ]", endSnapshot.column === 2, endSnapshot);
  const tailInfo = await monacoInfo([TOKENS.tail]);
  confirm("ctrl+end: 文件尾仍包含尾部 marker", tailInfo?.tokens[0]?.count === 1, tailInfo?.tail);
  await shot("03-ctrl-end-file-tail");

  // -------------------------------------------- 跨旧 262140 字节块的编辑
  // 编辑用的是真实键盘；Monaco 的自动闭合括号/引号可能让最终行文本与输入串
  // 不完全相同，因此期望长度按「编辑前真实行文本 -> 编辑后真实行文本」计算。
  const originalLineText = searched.lineTexts[0].text;
  await page.evaluate(([line]) => window.__fullTextE2E.goToLine(line, 1), [
    meta.boundary.lineNumber,
  ]);
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+End");
  await page.keyboard.type(TOKENS.boundaryEdit);
  const edited = await waitFor(
    async () => {
      const probes = await bufferTokens([
        TOKENS.boundaryLeft,
        TOKENS.boundaryRight,
        TOKENS.boundaryEdit,
      ]);
      if (!probes) return undefined;
      const [left, right, edit] = probes;
      return left.count === 0 && right.count === 0 && edit.count === 1 ? probes : undefined;
    },
    "跨旧块编辑写入 Store",
    20_000,
  );
  confirm(
    "edit: 跨 262140 的左右 token 同时被替换",
    edited[0].count === 0 && edited[1].count === 0,
    edited,
  );
  const editedModel = await waitFor(
    async () => {
      const info = await monacoInfo([TOKENS.boundaryEdit], [meta.boundary.lineNumber]);
      return info?.lineTexts[0]?.text.includes(TOKENS.boundaryEdit) ? info : undefined;
    },
    "真实 Monaco 模型同步跨块编辑",
    20_000,
  );
  const editedLineText = editedModel.lineTexts[0].text;
  const expectedEditedLength = meta.totalBytes - originalLineText.length + editedLineText.length;
  const editedBuffer = await activeTextBuffer();
  confirm(
    "edit: Store 中完整正文长度按替换行精确变化",
    editedBuffer?.textLength === expectedEditedLength,
    {
      textLength: editedBuffer?.textLength,
      expectedEditedLength,
      originalLineLength: originalLineText.length,
      editedLineLength: editedLineText.length,
    },
  );
  confirm("edit: 编辑后缓冲变脏", editedBuffer?.dirty === true, editedBuffer);
  confirm(
    "edit: 真实 Monaco 模型在该行保留替换后的合法 JSON token",
    editedLineText.includes(TOKENS.boundaryEdit),
    { editedLineText, tokens: editedModel.tokens },
  );
  confirm(
    "edit: 模型值长度与 Store 一致",
    editedModel.valueLength === expectedEditedLength,
    { valueLength: editedModel.valueLength, expectedEditedLength },
  );
  await shot("04-edit-across-262140");

  // ---------------------------------------------------------- 撤销 / 重做
  // 输入是真实键盘事件；Monaco 可能把自动闭合与正文输入拆成多个撤销步骤，
  // 因此按用户习惯连续撤销，直到恢复原始正文。
  const isOriginalText = async () => {
    const probes = await bufferTokens([
      TOKENS.boundaryLeft,
      TOKENS.boundaryRight,
      TOKENS.boundaryEdit,
    ]);
    const buffer = await activeTextBuffer();
    return Boolean(
      probes &&
        probes[0].count === 1 &&
        probes[1].count === 1 &&
        probes[2].count === 0 &&
        buffer?.textLength === meta.totalBytes &&
        buffer.dirty === false,
    );
  };
  if (!(await focusEditor())) throw new Error("撤销前无法聚焦真实 Monaco 编辑器");
  let undoAttempts = 0;
  while (undoAttempts < 8 && !(await isOriginalText())) {
    await page.keyboard.press("Control+z");
    undoAttempts += 1;
    await page.waitForTimeout(200);
  }
  confirm(
    `undo: Ctrl+Z 恢复跨块 token、完整长度与干净状态（${undoAttempts} 次）`,
    await isOriginalText(),
    { undoAttempts, buffer: await activeTextBuffer() },
  );
  const isRedone = async () => {
    const probes = await bufferTokens([TOKENS.boundaryEdit]);
    const buffer = await activeTextBuffer();
    return Boolean(
      probes &&
        probes[0].count === 1 &&
        buffer?.textLength === expectedEditedLength &&
        buffer.dirty === true,
    );
  };
  if (!(await focusEditor())) throw new Error("重做前无法聚焦真实 Monaco 编辑器");
  const redoUntilApplied = async (key) => {
    let attempts = 0;
    while (attempts < 8 && !(await isRedone())) {
      await page.keyboard.press(key);
      attempts += 1;
      await page.waitForTimeout(200);
    }
    return attempts;
  };
  let redoKey = "Control+y";
  let redoAttempts = await redoUntilApplied(redoKey);
  if (!(await isRedone())) {
    redoKey = "Control+Shift+z";
    redoAttempts += await redoUntilApplied(redoKey);
  }
  confirm(
    `redo: Ctrl+Y / Ctrl+Shift+Z 重新应用跨块编辑（${redoKey}，${redoAttempts} 次）`,
    await isRedone(),
    { redoKey, redoAttempts, buffer: await activeTextBuffer() },
  );

  return { expectedEditedLength };
}

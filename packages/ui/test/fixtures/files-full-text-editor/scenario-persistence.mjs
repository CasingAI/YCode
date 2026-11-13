import { SAVE_BUTTON_LABEL, TOKENS } from "./constants.mjs";

/**
 * 生产保存、保存后重开、IndexedDB 大草稿与冷启动恢复。
 *
 * 保存走真实标签按钮 -> saveFilesTextBuffer -> commitTextFile；恢复走生产
 * localStorage 会话 + IndexedDB v2 storageKey 合并。磁盘断言读取夹具的窗口服务状态。
 */
export async function runPersistenceScenarios(ctx, { expectedEditedLength }) {
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
    fixtureFile,
    meta,
  } = ctx;

  // ------------------------------------------------------ 保存并重开完整内容
  const saveButton = page.locator(`button[aria-label="${SAVE_BUTTON_LABEL}"]`).first();
  await saveButton.waitFor({ state: "visible", timeout: 10_000 });
  await saveButton.click();
  const savedBuffer = await waitFor(
    async () => {
      const buffer = await activeTextBuffer();
      return buffer && buffer.dirty === false && buffer.diskVersion === "v2" ? buffer : undefined;
    },
    "生产保存链路提交完整正文",
    30_000,
  );
  confirm("save: 保存后缓冲干净且 diskVersion 更新到 v2", savedBuffer.dirty === false, savedBuffer);
  confirm(
    "save: 提交的是完整编辑正文，而不是 262140 字节块",
    fixtureFile.version === "v2" && fixtureFile.text.includes(TOKENS.boundaryEdit),
    { version: fixtureFile.version, commits: fixtureFile.commits },
  );
  confirm(
    "save: 磁盘内容长度等于编辑后的完整长度",
    fixtureFile.bytes.length === expectedEditedLength,
    { diskBytes: fixtureFile.bytes.length, expectedEditedLength },
  );
  confirm(
    "save: 磁盘上跨块 token 已被替换，尾部 marker 保留",
    !fixtureFile.text.includes(TOKENS.boundaryLeft) &&
      !fixtureFile.text.includes(TOKENS.boundaryRight) &&
      fixtureFile.text.includes(TOKENS.tail),
  );
  await shot("05-saved-full-content");

  // 用新的 Store 重新走生产 openPath，验证保存后重开得到完整内容而不是首窗。
  await page.evaluate(() => window.__fullTextE2E.clearStorage());
  await mount("fresh");
  await openPath();
  const reopened = await waitFor(
    async () => {
      const buffer = await activeTextBuffer();
      return buffer && buffer.textLength === expectedEditedLength && buffer.diskVersion === "v2"
        ? buffer
        : undefined;
    },
    "重开后读取完整保存内容",
    60_000,
  );
  confirm(
    "reopen: 缓冲干净且版本仍是 v2",
    reopened.dirty === false && reopened.diskVersion === "v2",
    reopened,
  );
  const reopenedModel = await waitFor(
    async () => {
      const info = await monacoInfo([TOKENS.boundaryEdit, TOKENS.tail]);
      return info && info.lineCount === meta.lineCount ? info : undefined;
    },
    "重开后 Monaco 加载完整保存内容",
    90_000,
  );
  confirm(
    "reopen: 模型长度等于保存后的完整长度",
    reopenedModel.valueLength === expectedEditedLength,
    { valueLength: reopenedModel.valueLength, expectedEditedLength },
  );
  confirm(
    "reopen: 模型仍包含跨块编辑结果与尾部 marker",
    reopenedModel.tokens[0]?.count === 1 && reopenedModel.tokens[1]?.count === 1,
    reopenedModel.tokens,
  );
  confirm("reopen: 末行仍是 ]", reopenedModel.lastLine === "]", reopenedModel.lastLine);
  await shot("06-reopened-after-save");

  // ------------------------------------- IndexedDB 大草稿真实浏览器恢复
  await page.evaluate(([line]) => window.__fullTextE2E.goToLine(line, 1), [meta.tail.lineNumber]);
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+End");
  await page.keyboard.type(TOKENS.draftTail);
  const draft = await waitFor(
    async () => {
      const buffer = await activeTextBuffer();
      return buffer && buffer.dirty === true && buffer.textLength !== expectedEditedLength
        ? buffer
        : undefined;
    },
    "尾部未保存草稿进入 Store",
    20_000,
  );
  const draftLength = draft.textLength;
  await page.evaluate(() => window.__fullTextE2E.persistNow());
  const records = await waitFor(
    async () => {
      const list = await page.evaluate(() => window.__fullTextE2E.draftRecords());
      const record = list.find((entry) => entry.textLength === draftLength);
      return record ?? undefined;
    },
    "9.7 MiB 全文草稿写入 IndexedDB",
    20_000,
  );
  confirm(
    "idb: 大草稿以完整长度写入 IndexedDB",
    records.textLength === draftLength,
    { recordLength: records.textLength, draftLength },
  );
  confirm(
    "idb: 大草稿尾部包含未保存 token",
    records.tail?.includes(TOKENS.draftTail) === true,
    records.tail,
  );
  const session = await page.evaluate(() => window.__fullTextE2E.sessionInfo());
  const localDrafts = Array.isArray(session?.drafts) ? session.drafts : [];
  confirm(
    "idb: localStorage 会话没有保存 9.7 MiB 正文",
    localDrafts.every((entry) => (entry.textLength ?? 0) < 1024 * 1024),
    session,
  );
  confirm(
    "idb: localStorage 原始会话体积远小于完整草稿",
    typeof session?.rawLength === "number" && session.rawLength < 1_000_000,
    session?.rawLength,
  );
  confirm("idb: 未保存草稿尚未写入磁盘", !fixtureFile.text.includes(TOKENS.draftTail));
  await shot("07-draft-persisted-indexeddb");

  // 冷启动恢复：localStorage 标签 + IndexedDB 9.7 MiB 草稿合并后进入真实 Monaco。
  await mount("restore");
  const restored = await waitFor(
    async () => {
      const buffer = await activeTextBuffer();
      return buffer && buffer.dirty === true && buffer.textLength === draftLength ? buffer : undefined;
    },
    "冷启动从 IndexedDB 恢复完整草稿",
    30_000,
  );
  confirm("restore: 恢复的完整草稿仍脏且长度不变", restored.dirty === true, restored);
  const restoredTokens = await bufferTokens([TOKENS.draftTail]);
  confirm("restore: 恢复正文包含未保存草稿 token", restoredTokens?.[0]?.count === 1, restoredTokens);
  const restoredModel = await waitFor(
    async () => {
      const info = await monacoInfo([TOKENS.draftTail], [meta.tail.lineNumber]);
      return info && info.lineCount === meta.lineCount ? info : undefined;
    },
    "恢复后真实 Monaco 加载完整草稿",
    90_000,
  );
  confirm(
    "restore: 恢复的 Monaco 模型长度等于 IndexedDB 草稿长度",
    restoredModel.valueLength === draftLength,
    { valueLength: restoredModel.valueLength, draftLength },
  );
  confirm(
    "restore: 恢复的模型尾部行是未保存草稿",
    Boolean(restoredModel.lineTexts[0]?.text.includes(TOKENS.draftTail)),
    restoredModel.lineTexts,
  );
  confirm("restore: 草稿来自 IndexedDB 而不是磁盘", !fixtureFile.text.includes(TOKENS.draftTail));
  await shot("08-restored-from-indexeddb");
}

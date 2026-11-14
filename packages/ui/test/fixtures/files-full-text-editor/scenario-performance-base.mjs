import { E2E_PATH, TOKENS } from "./constants.mjs";
import {
  TYPING_BURST,
  resetFixtureSession,
  undoToClean,
  waitForCompleteBuffer,
  waitForDraftBody,
  waitForModel,
  waitForNoDrafts,
  waitForSavedV3,
} from "./performanceHelpers.mjs";

/**
 * 9.7 MiB 基础性能场景：逐键零全文读取、脏态 / 撤销、保存快照与 v3 草稿结构。
 *
 * 从 `scenario-performance.mjs` 拆出，避免单文件超过仓库 max-lines；断言全部是
 * 调用次数 / 功能 / 顺序性质，不写绝对耗时阈值。
 */
export async function runBaseScenarios(ctx) {
  const {
    page,
    confirm,
    shot,
    openPath,
    focusEditor,
    goToLine,
    monacoInfo,
    quickState,
    installModelCounters,
    beginMeasure,
    endMeasure,
    timeSnapshot,
    memoryProbe,
    resources,
  } = ctx;
  const { fixture: baseFixture, meta } = resources.base;
  baseFixture.reset();

  await resetFixtureSession(ctx);
  const openStarted = Date.now();
  await openPath(E2E_PATH);
  await waitForCompleteBuffer(ctx, meta);
  const openedModel = await waitForModel(ctx, meta);
  const openMs = Date.now() - openStarted;
  confirm(
    "perf-base: 9.7 MiB 完整正文与 Monaco 模型打开",
    openedModel.valueLength === meta.totalBytes,
    {
      openMs,
      valueLength: openedModel.valueLength,
    },
  );
  confirm("perf-base: 已安装公开 API 计数包装", await installModelCounters());

  if (!(await focusEditor())) throw new Error("逐键测量前无法聚焦真实 Monaco 编辑器");
  await goToLine(meta.boundary.lineNumber, 1);
  await page.keyboard.press("Home");

  const sessionBeforeTyping = await page.evaluate(() => window.__fullTextE2E.sessionInfo());
  beginMeasure();
  await page.keyboard.type(TYPING_BURST, { delay: 15 });
  const measure = await endMeasure();
  confirm("perf-base: 逐键区间已采样", Boolean(measure), measure);
  confirm(
    "perf-base: 8 次局部输入没有调用 model.getValue（一次也没有复制全文）",
    measure.counters.getValue === 0,
    measure.counters,
  );
  confirm(
    "perf-base: 逐键区间没有 localStorage / IndexedDB 写入",
    measure.counters.localStorageWrites === 0 && measure.counters.indexedDbPuts === 0,
    measure.counters,
  );
  confirm(
    "perf-base: 输入后脏态与长度立即更新",
    measure.dirty === true && measure.textLength === meta.totalBytes + TYPING_BURST.length,
    measure,
  );
  confirm(
    "perf-base: documentRevision / textChangeEpoch 随输入推进",
    (measure.documentRevision ?? 0) > 0 && (measure.textChangeEpoch ?? 0) > 0,
    {
      documentRevision: measure.documentRevision,
      textChangeEpoch: measure.textChangeEpoch,
    },
  );
  const sessionAfterTyping = await page.evaluate(() => window.__fullTextE2E.sessionInfo());
  confirm(
    "perf-base: 输入未立刻改写 localStorage 会话",
    sessionAfterTyping?.rawLength === sessionBeforeTyping?.rawLength,
    {
      before: sessionBeforeTyping?.rawLength,
      after: sessionAfterTyping?.rawLength,
    },
  );

  const undoAttempts = await undoToClean(ctx, meta.totalBytes);
  const undone = await quickState();
  confirm(
    `perf-base: Ctrl+Z 回到保存点后干净且长度恢复（${undoAttempts} 次）`,
    undone?.dirty === false && undone.textLength === meta.totalBytes,
    { undoAttempts, undone },
  );
  // 第一段逐键输入留下的草稿必须在测量保存前清理干净，否则同长度草稿会让
  // “等新草稿写入”的等待提前命中旧正文，把去抖持久化算进保存测量区间。
  await waitForNoDrafts(ctx);

  const searched = await monacoInfo(
    [TOKENS.boundaryLeft, TOKENS.boundaryRight, TOKENS.pastEightMiB, TOKENS.tail],
    [meta.boundary.lineNumber],
  );
  const tokenMatch = (token) => searched?.tokens.find((entry) => entry.token === token);
  confirm(
    "perf-base: 撤销后跨 256 KiB / 8 MiB 搜索与尾部 marker 仍正常",
    tokenMatch(TOKENS.boundaryLeft)?.count === 1 &&
      tokenMatch(TOKENS.boundaryRight)?.count === 1 &&
      tokenMatch(TOKENS.pastEightMiB)?.count === 1 &&
      tokenMatch(TOKENS.tail)?.count === 1,
    searched?.tokens,
  );

  const snapshot = await timeSnapshot();
  confirm(
    "perf-base: 显式快照读到的仍是完整 9.7 MiB 正文",
    snapshot?.textLength === meta.totalBytes,
    snapshot,
  );
  const memoryBeforeSave = await memoryProbe();

  // -------------------------------------------------- 保存 await 期间继续输入
  const beforeSave = TOKENS.saveDuringTyping.slice(0, 8);
  const duringSave = TOKENS.saveDuringTyping.slice(8);
  if (!(await focusEditor())) throw new Error("保存场景前无法聚焦真实 Monaco 编辑器");
  await page.keyboard.type(beforeSave, { delay: 15 });
  const dirtyBeforeSave = await quickState();
  confirm("perf-base: 保存前输入已变脏", dirtyBeforeSave?.dirty === true, dirtyBeforeSave);
  // 等输入去抖把当前正文真的写进 v3 草稿，确保测量区间里只剩下保存路径本身。
  await waitForDraftBody(ctx, meta.totalBytes + beforeSave.length);

  baseFixture.setCommitDelay(1200);
  // 阶段 1：保存提交进入 await 前的 commit 区间。此时还没有并发输入，
  // commit 只允许做一次显式正文快照。
  beginMeasure();
  const saveStarted = Date.now();
  const savePromise = page.evaluate(() => window.__fullTextE2E.saveActive());
  await page.waitForTimeout(200);
  const commitPhase = await endMeasure();
  // 阶段 2：保存 await 期间继续输入，再独立备份一次；备份窗口单独计数，
  // 不依赖 300ms 去抖是否碰巧触发，也不对总次数做脆弱断言。
  await page.keyboard.type(duringSave, { delay: 8 });
  beginMeasure();
  const backupPromise = page.evaluate(() => window.__fullTextE2E.persistNow());
  const saveResult = await savePromise;
  const saveMs = Date.now() - saveStarted;
  await backupPromise;
  const afterSave = await endMeasure();
  baseFixture.setCommitDelay(0);

  confirm("perf-base: 慢提交保存成功", saveResult?.ok === true, saveResult);
  confirm(
    "perf-base: 无并发输入的 commit 阶段只做一次显式正文快照",
    commitPhase?.counters.getValue === 1,
    commitPhase?.counters,
  );
  confirm(
    "perf-base: 保存 await 期间的独立备份确实产生正文快照（不再断言总次数）",
    (afterSave?.counters.getValue ?? 0) >= 1,
    afterSave?.counters,
  );
  confirm(
    "perf-base: 保存期间的新输入没有被清掉，缓冲仍脏",
    afterSave.dirty === true &&
      afterSave.textLength === meta.totalBytes + beforeSave.length + duringSave.length,
    afterSave,
  );
  confirm(
    "perf-base: savedText 只记录提交时刻的正文",
    afterSave.savedTextLength === meta.totalBytes + beforeSave.length,
    { savedTextLength: afterSave.savedTextLength },
  );
  const diskText = baseFixture.bytes;
  const commitLength = meta.totalBytes + beforeSave.length;
  confirm(
    "perf-base: 磁盘只写入提交快照，保存期间输入未落盘",
    diskText.length === commitLength &&
      diskText.includes(Buffer.from(beforeSave, "utf8")) &&
      !diskText.includes(Buffer.from(duringSave, "utf8")),
    {
      diskLength: diskText.length,
      commitLength,
      beforeSave,
      duringSave,
    },
  );

  // 保存期间的新输入让缓冲仍脏，因此 v3 持久化必须保留草稿：
  // bodies 是提交快照之后的脏正文，baselines 是保存成功提交的基线。
  const parts = await waitForSavedV3(ctx, {
    bodyLength: afterSave.textLength,
    baselineLength: commitLength,
  });
  const body = parts.bodies.find((entry) => entry.textLength > 0);
  const baseline = parts.baselines.find((entry) => entry.textLength > 0);
  confirm(
    "perf-base: v3 草稿正文与基线分流，且都来自真实持久化",
    parts.drafts.length === 1 &&
      body?.textLength === afterSave.textLength &&
      baseline?.textLength === commitLength &&
      parts.drafts[0].bodyRevision > 0 &&
      parts.drafts[0].savedRevision > 0,
    parts,
  );

  await shot("09-perf-base-typing-and-save");
  return {
    openMs,
    snapshotMs: snapshot?.ms ?? null,
    saveMs,
    typing: measure.counters,
    commitReads: commitPhase?.counters.getValue ?? null,
    backupReads: afterSave?.counters.getValue ?? null,
    undoAttempts,
    memoryBeforeSave,
  };
}

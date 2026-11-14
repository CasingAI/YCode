import { E2E_LARGE_PATH, E2E_SINGLE_LINE_PATH, TOKENS } from "./constants.mjs";
import {
  PERF_TYPED,
  TYPING_BURST,
  percentileSummary,
  resetFixtureSession,
  undoToClean,
  waitForCompleteBuffer,
  waitForModel,
} from "./performanceHelpers.mjs";
import { runBaseScenarios } from "./scenario-performance-base.mjs";

/**
 * 大文件逐键路径与保存快照的真实浏览器性能回归。
 *
 * 全部断言都是调用次数 / 功能 / 顺序性质，不写绝对耗时阈值：
 * - 逐键区间内 `model.getValue`、localStorage 写、IndexedDB 写都必须为 0；
 * - 输入后脏态立即可见，撤销回保存点自动干净；
 * - 50 MiB 多行与 10 MiB 单行分别记录 open / keypress / snapshot / save 的实际毫秒，
 *   只用于报告，不宣称达到某个 FPS；
 * - 保存 await 期间继续输入后仍保持脏，磁盘只包含提交时刻的快照。
 */

/** 50 MiB 多行：逐键路径与保存快照的真实耗时只记录、不设绝对阈值。 */
async function runLargeMultiLineScenarios(ctx) {
  const {
    page,
    confirm,
    shot,
    openPath,
    focusEditor,
    goToLine,
    installModelCounters,
    beginMeasure,
    endMeasure,
    beginKeypressMetrics,
    endKeypressMetrics,
    timeSnapshot,
    memoryProbe,
    quickState,
    resources,
  } = ctx;
  const { fixture: largeFixture, meta } = resources.large;
  largeFixture.reset();

  await resetFixtureSession(ctx);
  const openStarted = Date.now();
  await openPath(E2E_LARGE_PATH);
  const opened = await waitForCompleteBuffer(ctx, meta);
  const model = await waitForModel(ctx, meta);
  const openMs = Date.now() - openStarted;
  confirm(
    "perf-50mib: 50 MiB 多行完整正文与 Monaco 模型打开",
    opened.textLength === meta.totalBytes && model.valueLength === meta.totalBytes,
    {
      openMs,
      textLength: opened.textLength,
      valueLength: model.valueLength,
      lineCount: model.lineCount,
    },
  );
  confirm("perf-50mib: 已安装公开 API 计数包装", await installModelCounters());

  if (!(await focusEditor())) throw new Error("50 MiB 逐键测量前无法聚焦真实 Monaco 编辑器");
  await goToLine(1, 1);
  await page.keyboard.press("Home");
  const memoryBeforeTyping = await memoryProbe();

  const burst = PERF_TYPED.slice(0, 8);
  const rest = PERF_TYPED.slice(8);
  // 先量一小段连续输入：确认逐键路径不复制全文、不立刻持久化；
  // 再单独量剩余的几十次键入，避免把 300ms 去抖后的持久化算进逐键计数。
  beginMeasure();
  await page.keyboard.type(burst, { delay: 8 });
  const measure = await endMeasure();
  confirm("perf-50mib: 逐键区间已采样", Boolean(measure), measure);
  confirm(
    "perf-50mib: 8 次局部输入没有调用 model.getValue",
    measure.counters.getValue === 0,
    measure.counters,
  );
  confirm(
    "perf-50mib: 逐键区间没有 localStorage / IndexedDB 写入",
    measure.counters.localStorageWrites === 0 && measure.counters.indexedDbPuts === 0,
    measure.counters,
  );
  confirm(
    "perf-50mib: 输入后脏态与长度立即更新",
    measure.dirty === true && measure.textLength === meta.totalBytes + burst.length,
    { dirty: measure.dirty, textLength: measure.textLength },
  );

  const keypressStarted = await beginKeypressMetrics();
  confirm("perf-50mib: 键盘事件计时器已安装", keypressStarted === true);
  await page.keyboard.type(rest, { delay: 8 });
  const keypressMetrics = await endKeypressMetrics();
  confirm("perf-50mib: 键盘事件样本已结束采集", Boolean(keypressMetrics), keypressMetrics);
  confirm(
    "perf-50mib: 键盘事件到 model / store 都有成对样本",
    keypressMetrics.paired >= rest.length - 1 &&
      keypressMetrics.modelMs.max >= 0 &&
      keypressMetrics.storeMs.max >= 0,
    keypressMetrics,
  );
  const afterTyping = await quickState();
  confirm(
    "perf-50mib: 几十次键入后长度与脏态正确",
    afterTyping?.dirty === true && afterTyping.textLength === meta.totalBytes + PERF_TYPED.length,
    afterTyping,
  );

  const snapshot = await timeSnapshot();
  confirm(
    "perf-50mib: 显式快照长度等于当前完整正文",
    snapshot?.textLength === meta.totalBytes + PERF_TYPED.length,
    snapshot,
  );

  const saveStarted = Date.now();
  const saved = await page.evaluate(() => window.__fullTextE2E.saveActive());
  const saveMs = Date.now() - saveStarted;
  const memoryAfterSave = await memoryProbe();
  confirm("perf-50mib: 保存成功", saved?.ok === true, saved);
  confirm(
    "perf-50mib: 磁盘长度等于快照长度",
    largeFixture.bytes.length === (snapshot?.textLength ?? -1),
    { diskLength: largeFixture.bytes.length, snapshotLength: snapshot?.textLength },
  );
  confirm(
    "perf-50mib: 磁盘头部包含输入字符且尾部 marker 保留",
    largeFixture.bytes.subarray(0, PERF_TYPED.length).toString("utf8") === PERF_TYPED &&
      largeFixture.bytes.includes(Buffer.from(TOKENS.largeTail, "utf8")),
    {
      head: largeFixture.bytes.subarray(0, 40).toString("utf8"),
    },
  );

  await shot("10-perf-50mib-typing");
  return {
    openMs,
    snapshotMs: snapshot?.ms ?? null,
    saveMs,
    typing: measure.counters,
    keypress: percentileSummary(keypressMetrics),
    memoryBeforeTyping,
    memoryAfterSave,
  };
}

/** 10 MiB 单行：有界首行读取 + 超长单行输入路径。 */
async function runSingleLineScenarios(ctx) {
  const {
    page,
    confirm,
    shot,
    openPath,
    focusEditor,
    goToLine,
    installModelCounters,
    beginMeasure,
    endMeasure,
    timeSnapshot,
    quickState,
    firstLineProbe,
    memoryProbe,
    resources,
  } = ctx;
  const { fixture: singleFixture, meta } = resources.singleLine;
  singleFixture.reset();

  await resetFixtureSession(ctx);
  const openStarted = Date.now();
  await openPath(E2E_SINGLE_LINE_PATH);
  const opened = await waitForCompleteBuffer(ctx, meta);
  const model = await waitForModel(ctx, meta);
  const openMs = Date.now() - openStarted;
  confirm(
    "perf-single-line: 10 MiB 单行完整正文与 Monaco 单行模型打开",
    opened.textLength === meta.totalBytes && model.valueLength === meta.totalBytes,
    {
      openMs,
      textLength: opened.textLength,
      valueLength: model.valueLength,
      lineCount: model.lineCount,
    },
  );
  confirm("perf-single-line: 已安装公开 API 计数包装", await installModelCounters());

  const firstLine = await firstLineProbe();
  confirm(
    "perf-single-line: 首行读取有界到 2048 字符，不扫描 10 MiB 单行",
    firstLine?.textLength === 2048,
    firstLine,
  );
  confirm(
    "perf-single-line: Monaco 仍持有单行全文（分词按自身行长度上限自然降级）",
    firstLine?.lineCount === 1 && firstLine.lineMaxColumn >= meta.totalBytes + 1,
    firstLine,
  );

  if (!(await focusEditor())) throw new Error("单行逐键测量前无法聚焦真实 Monaco 编辑器");
  await goToLine(1, 1);
  await page.keyboard.press("Home");
  const memoryBeforeTyping = await memoryProbe();
  beginMeasure();
  await page.keyboard.type(TYPING_BURST, { delay: 15 });
  const measure = await endMeasure();
  confirm(
    "perf-single-line: 单行输入不调用 model.getValue",
    measure?.counters.getValue === 0,
    measure?.counters,
  );
  confirm(
    "perf-single-line: 单行输入后脏态与长度立即更新",
    measure?.dirty === true && measure.textLength === meta.totalBytes + TYPING_BURST.length,
    measure,
  );

  const snapshot = await timeSnapshot();
  confirm(
    "perf-single-line: 单行全文快照长度正确",
    snapshot?.textLength === meta.totalBytes + TYPING_BURST.length,
    snapshot,
  );
  const undoAttempts = await undoToClean(ctx, meta.totalBytes);
  const undone = await quickState();
  confirm(
    `perf-single-line: 撤销回保存点后干净且恢复单行长度（${undoAttempts} 次）`,
    undone?.dirty === false && undone.textLength === meta.totalBytes,
    { undoAttempts, undone },
  );

  await shot("11-perf-single-line");
  return {
    openMs,
    firstLineMs: firstLine?.ms ?? null,
    snapshotMs: snapshot?.ms ?? null,
    typing: measure?.counters ?? null,
    memoryBeforeTyping,
  };
}

export async function runPerformanceScenarios(ctx) {
  const base = await runBaseScenarios(ctx);
  const large = await runLargeMultiLineScenarios(ctx);
  const singleLine = await runSingleLineScenarios(ctx);
  ctx.result.performance = { base, large, singleLine };
  return ctx.result.performance;
}

import { TOKENS } from "./constants.mjs";

/** 性能场景共用的输入批次与等待 / 撤销 helper。 */

export const PERF_TYPED = TOKENS.perfTyped;
export const TYPING_BURST = PERF_TYPED.slice(0, 8);

export function percentileSummary(metrics) {
  return {
    keydowns: metrics.keydowns,
    modelChanges: metrics.modelChanges,
    storeChanges: metrics.storeChanges,
    paired: metrics.paired,
    modelP50: metrics.modelMs.p50,
    modelP95: metrics.modelMs.p95,
    modelMax: metrics.modelMs.max,
    storeP50: metrics.storeMs.p50,
    storeP95: metrics.storeMs.p95,
    storeMax: metrics.storeMs.max,
  };
}

export async function resetFixtureSession(ctx) {
  const { page, mount } = ctx;
  // 先重挂载让上一场景的编辑器 / 持久化定时器随卸载清理，再清会话存储。
  // 不手动 dispose Monaco 模型：生产编辑器组件只释放 editor，语言服务仍有
  // 异步任务引用旧模型，强行 dispose 会产生与业务无关的 pageerror。
  await mount("fresh");
  // 卸载本身不会取消旧 owner 已排队的去抖；等两段 300ms 去抖都跑完再删库。
  await page.waitForTimeout(800);
  await page.evaluate(() => window.__fullTextE2E.clearStorage());
}

export async function waitForCompleteBuffer(ctx, meta) {
  // quickState 只走 getValueLength / O(1) 长度，不复制 9.7 MiB / 50 MiB 正文。
  return ctx.waitFor(
    async () => {
      const state = await ctx.quickState();
      return state && state.dirty === false && state.textLength === meta.totalBytes
        ? state
        : undefined;
    },
    `完整正文 ${meta.totalBytes} 字节进入 Store`,
    240_000,
  );
}

export async function waitForModel(ctx, meta) {
  await ctx.waitFor(
    async () => {
      const editor = await ctx.editorSnapshot();
      return editor && editor.lineCount === meta.lineCount ? editor : undefined;
    },
    `真实 Monaco 模型 ${meta.lineCount} 行就绪`,
    300_000,
  );
  // 模型就绪后只做一次 O(1) 摘要读取，避免把 10 MiB 单行整行复制回 Node。
  return ctx.modelSummary();
}

export async function undoToClean(ctx, expectedLength, attempts = 10) {
  const { page, focusEditor, quickState } = ctx;
  if (!(await focusEditor())) throw new Error("撤销前无法聚焦真实 Monaco 编辑器");
  for (let index = 0; index < attempts; index += 1) {
    const state = await quickState();
    if (state?.dirty === false && state.textLength === expectedLength) return index;
    await page.keyboard.press("Control+z");
    await page.waitForTimeout(180);
  }
  return attempts;
}

/** 撤销回保存点后，持久化 owner 必须把旧草稿真正删掉，避免污染后续测量。 */
export function waitForNoDrafts(ctx) {
  return ctx.waitFor(
    async () => {
      const parts = await ctx.draftParts();
      return parts.drafts.length === 0 && parts.bodies.length === 0 && parts.baselines.length === 0
        ? parts
        : undefined;
    },
    "撤销后 v3 草稿已清理",
    120_000,
  );
}

/** 等输入去抖把当前正文真的写进 v3 草稿，测量区间里才只剩保存路径。 */
export function waitForDraftBody(ctx, expectedLength) {
  return ctx.waitFor(
    async () => {
      const parts = await ctx.draftParts();
      return parts.bodies.find((entry) => entry.textLength === expectedLength);
    },
    "输入去抖的 v3 草稿正文已完成",
    120_000,
  );
}

/** 保存期间继续输入后，草稿正文与已保存基线必须分流成两个长度。 */
export function waitForSavedV3(ctx, { bodyLength, baselineLength }) {
  return ctx.waitFor(
    async () => {
      const current = await ctx.draftParts();
      const body = current.bodies.find((entry) => entry.textLength > 0);
      const baseline = current.baselines.find((entry) => entry.textLength > 0);
      return current.drafts.length === 1 &&
        body?.textLength === bodyLength &&
        baseline?.textLength === baselineLength
        ? current
        : undefined;
    },
    "v3 草稿正文 / 基线收敛到保存期间继续输入的版本",
    120_000,
  );
}

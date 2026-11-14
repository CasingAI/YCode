import { E2E_PATH, TOKENS } from "./constants.mjs";
import {
  resetFixtureSession,
  undoToClean,
  waitForCompleteBuffer,
  waitForDraftBody,
  waitForModel,
} from "./performanceHelpers.mjs";

/**
 * 真实分屏 A/B 共享同一 Monaco model 的回归。
 *
 * 这里不是 store 单测：两个 view 都由生产 FilesEditorGroupPane 渲染成真实
 * Monaco editor，输入是真实键盘事件；分屏 / 关闭走生产 store 动作。
 * 覆盖 P1：绑定按 model 单例、view 引用计数、关闭一个视图后存活视图仍持有
 * 权威正文、同一 model 重建后保存基线仍在（撤销回保存点即 clean）。
 */

async function focusGroupEditor(ctx, groupId) {
  const editor = ctx.page
    .locator(`[data-files-e2e-group-host="${groupId}"] .monaco-editor`)
    .first();
  await editor.waitFor({ state: "visible", timeout: 20_000 });
  await editor.click({ position: { x: 120, y: 80 } });
  await ctx.page.keyboard.press("Control+End");
}

async function waitForLayout(ctx, predicate, label) {
  return ctx.waitFor(
    async () => {
      const info = await ctx.layoutInfo();
      return predicate(info) ? info : undefined;
    },
    label,
    60_000,
  );
}

export async function runSplitScenarios(ctx) {
  const {
    page,
    confirm,
    shot,
    openPath,
    quickState,
    installModelCounters,
    beginMeasure,
    endMeasure,
    layoutInfo,
    splitActiveView,
    closeGroup,
    remountEditors,
    resources,
  } = ctx;
  const { fixture, meta } = resources.base;
  fixture.reset();

  await resetFixtureSession(ctx);
  await openPath(E2E_PATH);
  await waitForCompleteBuffer(ctx, meta);
  await waitForModel(ctx, meta);

  const single = await layoutInfo();
  const groupA = single.groups[0]?.groupId;
  if (!groupA) throw new Error("分屏前没有可用的编辑器分组");
  confirm("split: 打开后只有一个真实 editor", single.editorCount === 1, single);
  confirm("split: 打开后绑定引用计数为 1", single.buffer?.documentAttachments === 1, single.buffer);

  // -------------------------------------------- 生产分屏复制 A/B 两个视图
  splitActiveView("right", "copy");
  const shared = await waitForLayout(
    ctx,
    (info) =>
      info.groups.length === 2 && info.editorCount === 2 && info.buffer?.documentAttachments === 2,
    "生产分屏渲染两个共享模型的真实 editor",
  );
  confirm("split: 生产 splitViewToEdge 生成两个分组", shared.groups.length === 2, shared.groups);
  confirm(
    "split: 两个真实 editor 挂载同一个 Monaco model",
    shared.editorModelIds.length === 2 &&
      shared.editorModelIds[0] !== undefined &&
      shared.editorModelIds[0] === shared.editorModelIds[1] &&
      shared.modelUris.length === 1,
    shared,
  );
  confirm(
    "split: Store 只有一份绑定，引用计数为 2",
    shared.buffer?.documentAttachments === 2 && shared.modelVersionIds.length === 1,
    shared.buffer,
  );

  const groupB = shared.groups.find((group) => group.groupId !== groupA)?.groupId;
  if (!groupB) throw new Error("分屏后找不到第二个分组");

  confirm("split: 真实 Monaco 计数包装已安装", await installModelCounters());
  const beforeSharedTyping = await quickState();
  const sharedTyped = TOKENS.splitSharedTyped;
  await focusGroupEditor(ctx, groupB);
  beginMeasure();
  await page.keyboard.type(sharedTyped, { delay: 25 });
  const sharedMeasure = await endMeasure();
  const afterSharedTyping = await quickState();

  confirm(
    "split: B 视图输入不调用 model.getValue",
    sharedMeasure?.counters.getValue === 0,
    sharedMeasure?.counters,
  );
  confirm(
    "split: B 视图输入后正文变脏且长度按真实输入增长",
    afterSharedTyping?.dirty === true &&
      afterSharedTyping.textLength === meta.totalBytes + sharedTyped.length,
    afterSharedTyping,
  );
  confirm(
    "split: 共享 model 的双监听按版本去重，每次按键只推进一次 revision / epoch",
    (afterSharedTyping?.documentRevision ?? 0) - (beforeSharedTyping?.documentRevision ?? 0) ===
      sharedTyped.length &&
      (afterSharedTyping?.textChangeEpoch ?? 0) - (beforeSharedTyping?.textChangeEpoch ?? 0) ===
        sharedTyped.length,
    {
      revisionDelta:
        (afterSharedTyping?.documentRevision ?? 0) - (beforeSharedTyping?.documentRevision ?? 0),
      epochDelta:
        (afterSharedTyping?.textChangeEpoch ?? 0) - (beforeSharedTyping?.textChangeEpoch ?? 0),
      typed: sharedTyped.length,
    },
  );

  // ------------------------------------ 关闭 B，存活 A 继续编辑同一正文
  closeGroup(groupB);
  const surviving = await waitForLayout(
    ctx,
    (info) => info.groups.length === 1 && info.editorCount === 1,
    "关闭 B 分组后 A 视图仍渲染真实 editor",
  );
  confirm(
    "split: 关闭一个视图后存活视图仍持有同一绑定，引用计数降为 1",
    surviving.groups[0]?.groupId === groupA &&
      surviving.buffer?.documentAttachments === 1 &&
      surviving.buffer?.dirty === true,
    surviving,
  );
  confirm(
    "split: 关闭一个视图不会丢失共享 model 的正文",
    surviving.buffer?.textLength === meta.totalBytes + sharedTyped.length,
    surviving.buffer,
  );

  const survivorTyped = TOKENS.splitSurvivorTyped;
  await focusGroupEditor(ctx, groupA);
  beginMeasure();
  await page.keyboard.type(survivorTyped, { delay: 25 });
  const survivorMeasure = await endMeasure();
  const afterSurvivorTyping = await quickState();
  const editedLength = meta.totalBytes + sharedTyped.length + survivorTyped.length;
  confirm(
    "split: 存活视图继续输入不调用 model.getValue",
    survivorMeasure?.counters.getValue === 0,
    survivorMeasure?.counters,
  );
  confirm(
    "split: 存活视图继续输入仍保持脏并共享同一正文",
    afterSurvivorTyping?.dirty === true && afterSurvivorTyping.textLength === editedLength,
    afterSurvivorTyping,
  );

  // ---------------------------------------- 无并发输入的保存只做一次快照
  await waitForDraftBody(ctx, editedLength);
  beginMeasure();
  const saveStarted = Date.now();
  const saved = await page.evaluate(() => window.__fullTextE2E.saveActive());
  const saveMs = Date.now() - saveStarted;
  const saveMeasure = await endMeasure();
  const clean = await quickState();
  confirm("split: 保存成功", saved?.ok === true, saved);
  confirm(
    "split: 无并发输入的 commit 阶段只显式快照正文一次",
    saveMeasure?.counters.getValue === 1,
    saveMeasure?.counters,
  );
  confirm(
    "split: 保存后缓冲干净且 savedText 等于提交正文",
    clean?.dirty === false &&
      clean.savedTextLength === editedLength &&
      clean.textLength === editedLength,
    clean,
  );
  confirm(
    "split: 磁盘收到两个视图完整编辑结果，且没有重建输入",
    fixture.bytes.length === editedLength &&
      fixture.text.includes(sharedTyped) &&
      fixture.text.includes(survivorTyped) &&
      !fixture.text.includes(TOKENS.splitRebuildTyped),
    {
      diskLength: fixture.bytes.length,
      editedLength,
      version: fixture.version,
    },
  );

  // --------------------------------- 同一 model 重建：基线 / 撤销保持
  const rebuildTyped = TOKENS.splitRebuildTyped;
  await focusGroupEditor(ctx, groupA);
  await page.keyboard.type(rebuildTyped, { delay: 25 });
  const dirtyAgain = await quickState();
  confirm(
    "split: 保存后输入重建测试字符，缓冲重新变脏",
    dirtyAgain?.dirty === true && dirtyAgain.textLength === editedLength + rebuildTyped.length,
    dirtyAgain,
  );
  const beforeRemount = await layoutInfo();
  remountEditors();
  const rebuilt = await waitForLayout(
    ctx,
    (info) =>
      info.editorCount === 1 &&
      info.buffer?.documentAttachments === 1 &&
      info.buffer?.modelVersionId === beforeRemount.buffer?.modelVersionId,
    "同一 Monaco model 重建后重新挂载真实 editor",
  );
  confirm(
    "split: 重建复用的是同一个 model，而不是新建空模型",
    rebuilt.modelUris[0] === beforeRemount.modelUris[0] &&
      rebuilt.editorModelIds[0] === beforeRemount.editorModelIds[0] &&
      rebuilt.buffer?.modelVersionId === beforeRemount.buffer?.modelVersionId,
    { beforeRemount, rebuilt },
  );
  confirm(
    "split: 重建后仍是脏态，正文与保存基线不同",
    rebuilt.buffer?.dirty === true &&
      rebuilt.buffer?.textLength === editedLength + rebuildTyped.length &&
      rebuilt.buffer?.savedDocumentVersionId !== null &&
      rebuilt.buffer?.savedDocumentVersionId !== undefined,
    rebuilt.buffer,
  );

  const undoAttempts = await undoToClean(ctx, editedLength, rebuildTyped.length + 5);
  const undone = await quickState();
  confirm(
    `split: 重建后撤销 ${undoAttempts} 次回到保存点即为 clean`,
    undone?.dirty === false &&
      undone.textLength === editedLength &&
      undone.modelVersionId === undone.savedDocumentVersionId,
    { undoAttempts, undone },
  );

  await shot("12-split-shared-model");
  return {
    saveMs,
    saveReads: saveMeasure?.counters.getValue ?? null,
    sharedTypingReads: sharedMeasure?.counters.getValue ?? null,
    survivorTypingReads: survivorMeasure?.counters.getValue ?? null,
    undoAttempts,
  };
}

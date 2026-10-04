import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const composerSource = readFileSync(
  new URL("../src/v4/ConversationComposer.tsx", import.meta.url),
  "utf8",
);

/** 截出某个本地函数的函数体，供断言用（按花括号配平，不依赖行号）。 */
function bodyOf(name: string): string {
  const start = composerSource.indexOf(`const ${name} = () => {`);
  assert.notEqual(start, -1, `找不到 ${name}`);
  let depth = 0;
  for (let index = composerSource.indexOf("{", start); index < composerSource.length; index += 1) {
    const char = composerSource[index];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return composerSource.slice(start, index + 1);
    }
  }
  throw new Error(`${name} 未闭合`);
}

test("点击发送时清空草稿，但不动可见编辑器", () => {
  const claim = bodyOf("claimSubmittedDraft");
  // 草稿要清：作用域恢复 effect 每次触发都无条件把 composerDraft 灌回编辑器，
  // 草稿留着在途正文就会被灌回可见输入框。
  assert.ok(claim.includes('updateComposerContent({ text: "" })'), "claim 必须清空草稿");
  // 编辑器不清：这才是「文本保留到确认」的全部意义。
  assert.equal(claim.includes("inputApiRef.current?.clear()"), false, "claim 不得清可见编辑器");
  assert.equal(claim.includes('updateText("")'), false, "claim 不得清空正文状态");
  assert.ok(
    claim.includes("suppressDraftPersistRef.current = true"),
    "claim 必须继续禁止在途跨作用域落盘",
  );
});

test("可见编辑器的清空只发生在确认之后", () => {
  const finalize = bodyOf("finalizeSubmittedDraft");
  assert.ok(finalize.includes("inputApiRef.current?.clear()"), "确认后必须清编辑器");
  assert.ok(finalize.includes('updateText("")'), "确认后必须同步正文状态");
  assert.ok(finalize.includes('updateComposerContent({ text: "" })'), "确认后必须幂等再清一次草稿");
});

test("失败路径无需回填：可见编辑器从未被动过", () => {
  const restore = bodyOf("restoreSubmittedDraft");
  // 回填逻辑删干净了；剩下的是「解除在途标记」这一件事。
  assert.equal(restore.includes("setEditorStateJson"), false, "不再需要回填编辑器状态");
  assert.equal(restore.includes("setText("), false, "不再需要回填正文");
  assert.equal(restore.includes("inputApiRef.current?.clear()"), false, "不再需要清空编辑器");
  assert.equal(restore.includes("updateComposerContent("), false, "草稿在 claim 时已清，无需回填");
  assert.ok(restore.includes("suppressDraftPersistRef.current = false"), "必须解除在途标记");
});

test("等待期间用户又敲了字时，不清掉他更新的正文", () => {
  const finalize = bodyOf("finalizeSubmittedDraft");
  assert.ok(
    finalize.includes("contentRevisionRef.current === cleanupRevision"),
    "清空前必须比对内容版本号",
  );
  assert.ok(finalize.includes("if (!untouched) return;"), "用户动过时必须放弃清空");
});

test("点击发送路径不再乐观清空编辑器", () => {
  // 旧实现在 claim 之后立刻 clear()，理由是「否则用户以为快捷键没生效」。
  // 现在由 Spinner + 可见正文承担这个信号，乐观清空整体移除。
  assert.equal(
    composerSource.includes("editorClearedOptimistically"),
    false,
    "乐观清空标记应随实现一起移除",
  );
});

test("发送瞬间不得把在途正文写进草稿", () => {
  // 回归点：作用域恢复 effect 每次触发都无条件把 composerDraft 灌回编辑器。
  // 在途正文一旦写进草稿，就会被一路灌回编辑器，并推进 contentRevisionRef 让收口守卫
  // 失配——文本永远清不掉。草稿语义是「还没发出去的文字」，在途文字不属于它。
  const body = bodyOf("claimSubmittedDraft");
  assert.equal(
    body.includes("persistDraftNow("),
    false,
    "claim 阶段不得把在途正文写进可恢复的草稿",
  );
  assert.ok(
    body.includes('updateComposerContent({ text: "" })'),
    "claim 阶段必须清空草稿，让恢复 effect 灌回空值",
  );
});

test("收口守卫与清空各只有一处，不能拆成两段", () => {
  // 回归点：清空一度同时存在于旧的发送成功块和 finalizeSubmittedDraft 里。
  // updateText 会推进 contentRevisionRef，第一处清完编辑器后第二处守卫必然失配，
  // 直接 return —— 草稿永远清不掉，下次该作用域挂载时旧正文又冒出来。
  const guardMatches = composerSource.match(/contentRevisionRef\.current === cleanupRevision/g);
  assert.equal(guardMatches?.length, 1, "「等待期间是否被改动」的判定必须只有一个求值点");
  const clearMatches = composerSource.match(/inputApiRef\.current\?\.clear\(\)/g);
  assert.equal(clearMatches?.length, 1, "编辑器清空必须只有一个执行点");
  // 草稿清空有两处且是有意的：claim 清空（让恢复 effect 灌回空值，不把在途正文带回来）
  // 与 finalize 的幂等兜底。位置由下面那条顺序用例钉住。
  const draftClearMatches = composerSource.match(/updateComposerContent\(\{ text: "" \}\)/g);
  assert.equal(draftClearMatches?.length, 2, "草稿清空只应在 claim 与 finalize 两处");
});

test("收口发生在附件移交之后、附件清理之前", () => {
  // 附件在失败时必须仍可重试，所以收口不能提前到 adoptSentAttachments 之前。
  const adopt = composerSource.indexOf("await attachmentsApi.adoptSentAttachments(");
  const finalize = composerSource.indexOf("finalizeSubmittedDraft();");
  const clearAttachments = composerSource.indexOf("attachmentsApi.clearAttachments(");
  assert.ok(adopt !== -1 && finalize !== -1 && clearAttachments !== -1);
  assert.ok(adopt < finalize, "收口必须在附件移交之后");
  assert.ok(finalize < clearAttachments, "收口必须在附件清理之前");
});

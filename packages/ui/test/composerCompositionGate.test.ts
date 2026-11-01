import assert from "node:assert/strict";
import test from "node:test";
import {
  disposeCompositionGate,
  isComposerComposing,
  notifyCompositionEnd,
  notifyCompositionStart,
  runWhenCompositionSettles,
  setEditableWhenCompositionSettles,
  type CompositionGateEditor,
} from "../src/prompt-editor/composerCompositionGate.js";

/** 组合态模拟：组合事件与 editor.isComposing() 分开控制，覆盖两者的「或」判定。 */
function createFakeEditor(initialComposing = false) {
  let composing = initialComposing;
  const editableCalls: boolean[] = [];
  const editor: CompositionGateEditor = {
    isComposing: () => composing,
    setEditable: (editable: boolean) => {
      editableCalls.push(editable);
    },
  };
  return {
    editor,
    editableCalls,
    setComposing: (next: boolean) => {
      composing = next;
    },
  };
}

/** 等微任务队列与 compositionend 的延迟回放都跑完。 */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("非组合态：写入与可编辑态立即执行", () => {
  const { editor, editableCalls } = createFakeEditor();
  const applied: string[] = [];

  runWhenCompositionSettles(editor, "replace", () => applied.push("text"));
  setEditableWhenCompositionSettles(editor, false);

  assert.deepEqual(applied, ["text"], "非组合态不能推迟写入");
  assert.deepEqual(editableCalls, [false], "非组合态不能推迟可编辑态切换");
  assert.equal(isComposerComposing(editor), false);
});

test("组合期间：写入排队到 compositionend 之后执行", async () => {
  const { editor, setComposing } = createFakeEditor();
  const applied: string[] = [];

  notifyCompositionStart(editor);
  setComposing(true);
  runWhenCompositionSettles(editor, "replace", () => applied.push("restore"));

  assert.deepEqual(applied, [], "组合期间不得写树");
  assert.equal(isComposerComposing(editor), true);

  setComposing(false);
  notifyCompositionEnd(editor);
  assert.deepEqual(applied, [], "回放必须等到微任务，不能与 compositionend 同步执行");

  await settle();
  assert.deepEqual(applied, ["restore"]);
  assert.equal(isComposerComposing(editor), false);
});

test("同一 replace 键只回放最后一次请求", async () => {
  const { editor, setComposing } = createFakeEditor();

  notifyCompositionStart(editor);
  setComposing(true);
  const applied: string[] = [];
  runWhenCompositionSettles(editor, "replace", () => applied.push("draft-old"));
  runWhenCompositionSettles(editor, "replace", () => applied.push("draft-new"));

  setComposing(false);
  notifyCompositionEnd(editor);
  await settle();

  assert.deepEqual(applied, ["draft-new"], "草稿恢复连发两次只应回放最新一次");
});

test("追加类写入各自编号，按登记顺序全部回放", async () => {
  const { editor, setComposing } = createFakeEditor();

  notifyCompositionStart(editor);
  setComposing(true);
  const applied: string[] = [];
  runWhenCompositionSettles(editor, "append:1", () => applied.push("mention"));
  runWhenCompositionSettles(editor, "append:2", () => applied.push("text"));

  setComposing(false);
  notifyCompositionEnd(editor);
  await settle();

  assert.deepEqual(applied, ["mention", "text"], "追加内容不能被后一次覆盖");
});

test("可编辑态翻转在组合期间只保留最后一次目标值", async () => {
  const { editor, editableCalls, setComposing } = createFakeEditor();

  notifyCompositionStart(editor);
  setComposing(true);
  setEditableWhenCompositionSettles(editor, false);
  setEditableWhenCompositionSettles(editor, true);
  setEditableWhenCompositionSettles(editor, false);

  assert.deepEqual(editableCalls, [], "组合期间不得翻转 contentEditable");

  setComposing(false);
  notifyCompositionEnd(editor);
  await settle();

  assert.deepEqual(editableCalls, [false], "组合结束后只应用最后一次目标值");
});

test("组合结束与新组合落在同一轮时，等下一次 compositionend 再回放", async () => {
  const { editor, setComposing } = createFakeEditor();
  const applied: string[] = [];

  notifyCompositionStart(editor);
  setComposing(true);
  runWhenCompositionSettles(editor, "replace", () => applied.push("pending"));

  setComposing(false);
  notifyCompositionEnd(editor);
  // 上一句提交后输入法立刻开始下一句：新组合已经置位，此时回放会打断新组合。
  notifyCompositionStart(editor);
  setComposing(true);
  await settle();

  assert.deepEqual(applied, [], "新组合开始时不能回放排队写入");

  setComposing(false);
  notifyCompositionEnd(editor);
  await settle();
  assert.deepEqual(applied, ["pending"]);
});

test("只有 editor.isComposing() 为真（缺少组合事件）时也推迟写入", async () => {
  const { editor, setComposing } = createFakeEditor();
  const applied: string[] = [];

  setComposing(true);
  runWhenCompositionSettles(editor, "replace", () => applied.push("pending"));
  assert.deepEqual(applied, [], "isComposing 也是组合态事实源");

  // 没有 compositionstart 就没有 compositionend 的延迟回放；此时失焦兜底会调用
  // notifyCompositionEnd，把排队写入放出去。
  setComposing(false);
  notifyCompositionEnd(editor);
  await settle();
  assert.deepEqual(applied, ["pending"]);
});

test("dispose 后丢弃未决请求", async () => {
  const { editor, editableCalls, setComposing } = createFakeEditor();
  const applied: string[] = [];

  notifyCompositionStart(editor);
  setComposing(true);
  runWhenCompositionSettles(editor, "replace", () => applied.push("pending"));
  setEditableWhenCompositionSettles(editor, false);
  disposeCompositionGate(editor);

  setComposing(false);
  notifyCompositionEnd(editor);
  await settle();

  assert.deepEqual(applied, []);
  assert.deepEqual(editableCalls, []);
});

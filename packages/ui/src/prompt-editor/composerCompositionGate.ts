// 组合输入（IME / 语音听写）排他区：见 docs/specs/composer-ime-composition-safety.md。
//
// 语音输入法通常把整段口述当作一个长组合串持续上屏。组合期间 DOM 里的文字属于浏览器，
// Lexical 的 state 只是跟随；此刻如果程序化改写编辑器（草稿恢复/外部预填/撤回/发送 clear
// 都会 root.clear() 后整树重建）或翻转 contentEditable，浏览器会结束当前组合，整段已识别
// 文字随之丢失，只剩打断后重新开始的那一小段。
//
// 因此组合期间这些动作只登记、不执行，compositionend 之后按登记顺序回放；
// 同一目标只保留最后一次请求（草稿恢复连发两次不该回放两遍）。
//
// 读取不受约束：组合期间 DOM 才是事实源，onChange 已经把文本同步进草稿，
// getMarkdown / getEditorState 照常返回当前值。

/** 只依赖编辑器的最小契约，便于单测直接构造替身。 */
export interface CompositionGateEditor {
  isComposing: () => boolean;
  setEditable: (editable: boolean) => void;
}

interface CompositionGateState {
  /** compositionstart 之后、compositionend 的微任务收尾之前为真。 */
  composing: boolean;
  /** 每次 compositionstart 递增：组合结束与新组合开始落在同一轮时，用代际判断是否到期。 */
  epoch: number;
  /** 组合期间记录的可编辑态目标；null 表示没有未决请求。 */
  pendingEditable: boolean | null;
  /** 按登记顺序回放；同一键覆盖为最后一次请求。 */
  pendingWrites: Map<string, () => void>;
}

const gateStates = new WeakMap<CompositionGateEditor, CompositionGateState>();

function readGateState(editor: CompositionGateEditor): CompositionGateState {
  let state = gateStates.get(editor);
  if (!state) {
    state = { composing: false, epoch: 0, pendingEditable: null, pendingWrites: new Map() };
    gateStates.set(editor, state);
  }
  return state;
}

function flushGate(editor: CompositionGateEditor, state: CompositionGateState) {
  const nextEditable = state.pendingEditable;
  const writes = [...state.pendingWrites.values()];
  state.pendingEditable = null;
  state.pendingWrites.clear();

  // 可编辑态先应用：写回文本时编辑器应已回到最终可编辑状态。
  if (nextEditable !== null) {
    editor.setEditable(nextEditable);
  }
  for (const write of writes) {
    write();
  }
}

/** 组合态判定：组合事件与 editor.isComposing() 取「或」，不单独依赖任一方。 */
export function isComposerComposing(editor: CompositionGateEditor): boolean {
  return readGateState(editor).composing || editor.isComposing();
}

export function notifyCompositionStart(editor: CompositionGateEditor) {
  const state = readGateState(editor);
  state.composing = true;
  state.epoch += 1;
}

/**
 * 组合结束。真正回放排到微任务：Lexical 在 compositionend 同一轮还会提交一次 update，
 * 同步回写会让这次提交读到半成品树；且「上一句提交」与「下一句开始组合」可能落在同一轮，
 * 那时新组合已把 composing 置回 true，必须等下一次 compositionend。
 */
export function notifyCompositionEnd(editor: CompositionGateEditor) {
  const state = readGateState(editor);
  const epoch = state.epoch;
  queueMicrotask(() => {
    if (state.epoch !== epoch) return;
    state.composing = false;
    flushGate(editor, state);
  });
}

/**
 * 组合期间把写入推迟到 compositionend；否则立即执行（时序与改动前逐字一致）。
 * key 相同的多次请求只保留最后一次，并按首次登记的位置回放。
 */
export function runWhenCompositionSettles(
  editor: CompositionGateEditor,
  key: string,
  write: () => void,
) {
  const state = readGateState(editor);
  if (!isComposerComposing(editor)) {
    write();
    return;
  }
  state.pendingWrites.set(key, write);
}

/** 组合期间翻转 contentEditable 会让浏览器结束组合；只记录最后一次目标值。 */
export function setEditableWhenCompositionSettles(
  editor: CompositionGateEditor,
  editable: boolean,
) {
  const state = readGateState(editor);
  if (!isComposerComposing(editor)) {
    if (state.pendingEditable === null) {
      editor.setEditable(editable);
      return;
    }
    // 已有未决目标（组合刚结束、微任务还没到）：直接覆盖目标值，等回放统一应用。
    state.pendingEditable = editable;
    return;
  }
  state.pendingEditable = editable;
}

/** 组件卸载：丢弃未决请求，避免对已卸载的编辑器写属性。 */
export function disposeCompositionGate(editor: CompositionGateEditor) {
  const state = gateStates.get(editor);
  gateStates.delete(editor);
  if (!state) return;
  // 递增代际让「已经排进微任务、但还没到期」的回放失效。
  state.epoch += 1;
  state.pendingEditable = null;
  state.pendingWrites.clear();
}

/**
 * 剪贴板写入：异步 Clipboard API 优先，失败或不可用时回退 execCommand。
 *
 * 为什么必须有兜底：Clipboard API 只在安全上下文暴露。桌面远控按设计发的是
 * `http://<局域网IP>:<端口>`（见 mobile-remote-control.md），非安全上下文里
 * `navigator.clipboard` 整个是 undefined，异步路径根本不存在。加上部分内置
 * webview（微信 X5 等）虽然暴露了 API 却会以 NotAllowedError 拒绝写入。
 * 这两种情况下复制要么静默失败、要么被当成「点了没反应」。
 */
export async function writeTextToClipboard(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && typeof navigator.clipboard?.writeText === "function") {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // 落到 execCommand 兜底：API 存在但拒绝写入时它往往仍然可用。
    }
  }

  if (!copyWithExecCommand(text)) {
    throw new Error("clipboard-write-unavailable");
  }
}

/**
 * execCommand("copy") 兜底。非安全上下文里唯一可用的复制路径。
 *
 * 移动端要注意两件事：
 * - textarea 必须 readonly，否则会弹出软键盘遮挡远控界面（与 pickerFocus.ts
 *   的同源取舍：触屏端不愿意主动把焦点送回可编辑元素）。
 * - 用 fixed + 1px + opacity:0 挂载而不是 display:none——隐藏元素无法选中，
 *   execCommand 会返回 false。挂上后立即移除，选区复原到原焦点元素。
 */
function copyWithExecCommand(text: string): boolean {
  if (typeof document === "undefined" || typeof document.execCommand !== "function") {
    return false;
  }

  const previouslyFocused =
    typeof HTMLElement !== "undefined" && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "0";
  textarea.style.width = "1px";
  textarea.style.height = "1px";
  textarea.style.padding = "0";
  textarea.style.border = "none";
  textarea.style.outline = "none";
  textarea.style.boxShadow = "none";
  textarea.style.background = "transparent";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);

  try {
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
    // body 自身持有焦点时不必还回去，避免凭空把键盘叫出来。
    if (previouslyFocused !== null && previouslyFocused !== document.body) {
      previouslyFocused.focus();
    }
  }
}

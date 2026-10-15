import { toast } from "@/components/ui/toast.js";
import { writeTextToClipboard } from "@/lib/clipboard.js";
import { logger } from "@/logger.js";

type FormatMessage = (descriptor: { id: string }, values?: Record<string, string>) => string;

/**
 * 写剪贴板并在失败时弹统一 toast；成功返回 true，失败返回 false（且已提示）。
 * 唯一写入入口仍是 lib/clipboard.ts（见 docs/specs/clipboard-write.md）；
 * 本函数只把「记日志 + 失败 toast」这层重复写法收敛到一处，供需要成功态反馈的调用点复用。
 */
export async function copyTextToClipboard(
  text: string,
  formatMessage: FormatMessage,
  logScope: string,
): Promise<boolean> {
  try {
    await writeTextToClipboard(text);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(logScope, { error: message });
    toast(formatMessage({ id: "clipboard.copyFailed" }, { error: message }), {
      variant: "warning",
    });
    return false;
  }
}

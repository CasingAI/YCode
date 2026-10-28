import type { NativePathDialogOptions } from "@zcode/shared";

/** 直接复用平台契约，避免 UI 侧自建选项类型与 IPlatformService 漂移。 */
export type FilesSaveAsNativeDialogOptions = NativePathDialogOptions;

/** 原生另存为所需的最小平台能力；Desktop preload 缺失方法时保持隐藏。 */
export interface FilesSaveAsNativeDialogPlatform {
  canSelectFilePath?: boolean;
  showSaveDialog?: (options?: FilesSaveAsNativeDialogOptions) => Promise<string | null>;
}

export type FilesSaveAsNativeDialogOutcome =
  | { kind: "path"; path: string }
  | { kind: "cancelled" }
  | { kind: "error" }
  | { kind: "ignored" };

/**
 * 只有本机目标、平台声明可返回本机路径、且当前 preload 提供原生方法时才显示入口。
 * `canSelectFilePath` 表示本机路径能力，不能用来判断 Desktop 身份。
 */
export function canUseFilesSaveAsNativeDialog(params: {
  allowNativePath: boolean;
  platform: FilesSaveAsNativeDialogPlatform | null | undefined;
}): boolean {
  return (
    params.allowNativePath === true &&
    params.platform?.canSelectFilePath === true &&
    typeof params.platform.showSaveDialog === "function"
  );
}

/**
 * 单请求控制器：一个另存为目标至多一个原生请求。
 *
 * - 请求期间重复触发返回 `ignored`，不打开第二个系统对话框。
 * - `invalidate()` 让关闭、卸载或更换目标后的迟到路径 / 错误全部作废；
 *   新的目标可以立即开始新请求，不依赖超时。
 */
export class FilesSaveAsNativeDialogController {
  private pendingRequest = false;
  private generation = 0;

  get pending(): boolean {
    return this.pendingRequest;
  }

  invalidate(): void {
    this.generation += 1;
    this.pendingRequest = false;
  }

  async run(
    showSaveDialog: (options?: FilesSaveAsNativeDialogOptions) => Promise<string | null>,
    options: FilesSaveAsNativeDialogOptions,
  ): Promise<FilesSaveAsNativeDialogOutcome> {
    if (this.pendingRequest) {
      return { kind: "ignored" };
    }
    const generation = this.generation;
    this.pendingRequest = true;
    try {
      const path = await showSaveDialog(options);
      if (generation !== this.generation) {
        return { kind: "ignored" };
      }
      return path ? { kind: "path", path } : { kind: "cancelled" };
    } catch {
      if (generation !== this.generation) {
        return { kind: "ignored" };
      }
      return { kind: "error" };
    } finally {
      if (generation === this.generation) {
        this.pendingRequest = false;
      }
    }
  }
}

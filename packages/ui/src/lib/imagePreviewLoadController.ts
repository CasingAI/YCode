import type { CodeViewerWorkspaceScope } from "./codeViewerWorkspaceScope.js";
import type { ImagePreviewFileService, ReadImagePreviewBlobParams } from "./imagePreviewData.js";

/**
 * 图片预览读取错误分类。
 *
 * - `missing`: 文件不存在，沿用现有缺失提示。
 * - `too-large`: 原始文件超过图片预览上限，展示带 64 MiB 的本地化提示。
 * - `unavailable`: 其它读取失败，展示通用图片不可用提示，不暴露原始绝对路径。
 */
export type ImagePreviewErrorKind = "missing" | "too-large" | "unavailable" | null;

export interface ImagePreviewLoadState {
  /** 当前有效的 Blob object URL；控制器是它唯一所有者。 */
  url: string | null;
  loading: boolean;
  errorKind: ImagePreviewErrorKind;
}

export interface ImagePreviewLoadSource extends CodeViewerWorkspaceScope {
  fileService: ImagePreviewFileService;
  path: string;
  mediaType: string;
}

export type ReadImagePreviewBlob = (
  params: ReadImagePreviewBlobParams & CodeViewerWorkspaceScope,
) => Promise<Blob | null>;

export interface ImagePreviewLoadControllerOptions {
  readImagePreviewBlob: ReadImagePreviewBlob;
  isMissingFileError: (error: unknown) => boolean;
  isTooLargeError: (error: unknown) => boolean;
  createObjectUrl?: (blob: Blob) => string;
  revokeObjectUrl?: (url: string) => void;
  /** 只用于诊断日志；错误文案由调用方按 errorKind 本地化。 */
  onError?: (params: { error: unknown; path: string }) => void;
}

const IDLE_STATE: ImagePreviewLoadState = Object.freeze({
  url: null,
  loading: false,
  errorKind: null,
});

function createDefaultObjectUrl(blob: Blob): string {
  return URL.createObjectURL(blob);
}

function revokeDefaultObjectUrl(url: string): void {
  URL.revokeObjectURL(url);
}

function isSameSource(
  left: ImagePreviewLoadSource | null,
  right: ImagePreviewLoadSource | null,
): boolean {
  if (!left || !right) {
    return left === right;
  }

  // 本地多 workspace 共享同一 Host 服务时，同绝对路径也必须按 workspace 身份隔离；
  // 远程则再叠加 session id，避免同路径资源串到另一个会话。
  return (
    left.fileService === right.fileService &&
    left.path === right.path &&
    left.mediaType === right.mediaType &&
    (left.workspaceIdentity?.trim() || left.workspacePath) ===
      (right.workspaceIdentity?.trim() || right.workspacePath) &&
    left.workspaceRemoteSessionId === right.workspaceRemoteSessionId
  );
}

interface PendingLoad {
  abortController: AbortController;
}

/**
 * 图片预览 Blob URL 的唯一所有者。
 *
 * 列表与详情切换是高频操作，控制器用 generation + AbortSignal 双重判定：
 * 旧请求可以自然完成，但只有当前 generation 的结果才允许创建 / 保留 URL。
 * 这避免“先切走再撤销”顺序下把旧 URL 挂到新图片上，也避免迟到错误覆盖新状态。
 */
export class ImagePreviewLoadController {
  private readonly options: ImagePreviewLoadControllerOptions;
  private readonly listeners = new Set<() => void>();
  private state: ImagePreviewLoadState = IDLE_STATE;
  private source: ImagePreviewLoadSource | null = null;
  private pending: PendingLoad | null = null;
  private generation = 0;
  private objectUrl: string | null = null;

  constructor(options: ImagePreviewLoadControllerOptions) {
    this.options = options;
  }

  readonly getState = (): ImagePreviewLoadState => this.state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  setSource(source: ImagePreviewLoadSource | null): void {
    if (isSameSource(this.source, source)) {
      return;
    }

    this.stopCurrentLoad();
    this.source = source;

    if (!source) {
      this.setState(IDLE_STATE);
      return;
    }

    const generation = ++this.generation;
    const abortController = new AbortController();
    this.pending = { abortController };
    this.setState({ url: null, loading: true, errorKind: null });
    void this.load(source, generation, abortController.signal);
  }

  /** 换源、关闭标签或卸载时通过 setSource(null) 停止后续分块请求并撤销已有 URL。 */
  private stopCurrentLoad(): void {
    // generation 先递增：abort 同步派发时，旧 load 的 then/catch 也已经是过期结果。
    this.generation += 1;
    const pending = this.pending;
    this.pending = null;
    pending?.abortController.abort();
    this.revokeObjectUrl();
  }

  private revokeObjectUrl(): void {
    const url = this.objectUrl;
    if (!url) {
      return;
    }

    this.objectUrl = null;
    (this.options.revokeObjectUrl ?? revokeDefaultObjectUrl)(url);
  }

  private async load(
    source: ImagePreviewLoadSource,
    generation: number,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const blob = await this.options.readImagePreviewBlob({ ...source, signal });

      if (generation !== this.generation || signal.aborted) {
        return;
      }

      if (!blob) {
        // helper 约定 abort 时返回 null；非 abort 的空结果按不可用处理并结束 loading。
        this.setState({ url: null, loading: false, errorKind: "unavailable" });
        return;
      }

      const url = (this.options.createObjectUrl ?? createDefaultObjectUrl)(blob);
      if (generation !== this.generation || signal.aborted) {
        // 过期结果不得成为可见状态；已经创建的 URL 立即释放。
        (this.options.revokeObjectUrl ?? revokeDefaultObjectUrl)(url);
        return;
      }

      this.objectUrl = url;
      this.setState({ url, loading: false, errorKind: null });
    } catch (error) {
      if (generation !== this.generation || signal.aborted) {
        return;
      }

      this.options.onError?.({ error, path: source.path });
      this.setState({
        url: null,
        loading: false,
        errorKind: this.classifyError(error),
      });
    }
  }

  private classifyError(error: unknown): Exclude<ImagePreviewErrorKind, null> {
    if (this.options.isMissingFileError(error)) {
      return "missing";
    }
    if (this.options.isTooLargeError(error)) {
      return "too-large";
    }
    return "unavailable";
  }

  private setState(nextState: ImagePreviewLoadState): void {
    if (
      this.state.url === nextState.url &&
      this.state.loading === nextState.loading &&
      this.state.errorKind === nextState.errorKind
    ) {
      return;
    }

    this.state = nextState;
    for (const listener of this.listeners) {
      listener();
    }
  }
}

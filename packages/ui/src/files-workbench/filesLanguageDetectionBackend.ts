import { logger } from "@/logger.js";

/**
 * 内容级语言检测后端：在 Web Worker 里跑 guesslang 模型。
 *
 * 背景：文件名与首行都判不出语言时（例如未知扩展名的文件），才需要看内容。
 * 推理跑在 Worker 里，避免主线程被 tfjs 阻塞；Worker 不可用或模型加载失败时
 * 一律返回「没有结论」，调用方保持原语言，不报错、不阻塞。
 *
 * 结构对齐 `workspaceFileSearchFilterBackend.ts`：seq 去旧、Promise 不 reject、
 * 失败降级。
 */
export interface FilesLanguageDetectionBackend {
  /** 返回 Monaco 语言 id；没有结论或不可用时返回 undefined。Promise 永不 reject。 */
  detect(content: string): Promise<string | undefined>;
  dispose(): void;
}

/** 低于这个长度不送模型：短片段的判断没有意义。 */
const MIN_CONTENT_LENGTH = 20;

/** 送进模型的最大字符数，与 VS Code 的取样上限一致。 */
const MAX_CONTENT_LENGTH = 10000;

function createUnavailableBackend(reason: string): FilesLanguageDetectionBackend {
  logger.warn("[files-language-detection] 内容级检测不可用", { reason });
  return {
    detect: () => Promise.resolve(undefined),
    dispose: () => {},
  };
}

function createFilesLanguageDetectionBackend(): FilesLanguageDetectionBackend {
  // Node 测试环境没有 module worker 运行时，直接走不可用路径。
  if (typeof document === "undefined") {
    return createUnavailableBackend("no-document");
  }
  let worker: Worker;
  try {
    worker = new Worker(new URL("./filesLanguageDetection.worker.ts", import.meta.url), {
      type: "module",
      name: "zcode-files-language-detection",
    });
  } catch (error) {
    return createUnavailableBackend(error instanceof Error ? error.message : String(error));
  }

  let seq = 0;
  const pending = new Map<number, { resolve: (languageId: string | undefined) => void }>();
  let disposed = false;

  worker.onmessage = (event: MessageEvent<{ type: string; seq?: number; languageId?: string }>) => {
    const data = event.data;
    if (data.type !== "result" || typeof data.seq !== "number") return;
    const waiter = pending.get(data.seq);
    if (!waiter) return;
    pending.delete(data.seq);
    waiter.resolve(typeof data.languageId === "string" ? data.languageId : undefined);
  };

  worker.onerror = (event) => {
    logger.warn("[files-language-detection] Worker 运行失败，本轮检测结果丢弃", {
      message: event.message,
    });
    for (const [, waiter] of pending) {
      waiter.resolve(undefined);
    }
    pending.clear();
  };

  return {
    detect(content: string) {
      if (disposed) return Promise.resolve(undefined);
      if (content.trim().length < MIN_CONTENT_LENGTH) return Promise.resolve(undefined);
      const payload = content.slice(0, MAX_CONTENT_LENGTH);
      seq += 1;
      const currentSeq = seq;
      return new Promise<string | undefined>((resolve) => {
        pending.set(currentSeq, { resolve });
        worker.postMessage({ type: "detect", seq: currentSeq, content: payload });
      });
    },
    dispose() {
      disposed = true;
      seq += 1;
      for (const [, waiter] of pending) {
        waiter.resolve(undefined);
      }
      pending.clear();
      worker.terminate();
    },
  };
}

let sharedBackend: FilesLanguageDetectionBackend | undefined;

/**
 * 共享后端：Worker 与模型只建一次，后续检测复用。
 * 推理很贵（要加载约 1MB 权重），不能每次开文件都新建。
 */
export function getFilesLanguageDetectionBackend(): FilesLanguageDetectionBackend {
  if (!sharedBackend) {
    sharedBackend = createFilesLanguageDetectionBackend();
  }
  return sharedBackend;
}

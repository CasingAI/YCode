import { ModelOperations } from "@vscode/vscode-languagedetection";
import languageDetectionChunk from "@vscode/vscode-languagedetection/dist/lib/979.js";
import modelJsonUrl from "@vscode/vscode-languagedetection/model/model.json?url";
import weightsUrl from "@vscode/vscode-languagedetection/model/group1-shard1of1.bin?url";
import {
  selectFilesDetectedLanguage,
  type FilesLanguageDetectionCandidate,
} from "@/files-workbench/filesLanguageDetectionConfidence.js";

/**
 * 内容级语言检测 Worker。
 *
 * 模型用 `@vscode/vscode-languagedetection`（guesslang 的 ML 模型，MIT）。
 * 该包的产物是 webpack `target: 'node'` 的 UMD：内部用 `fs`/`path` 读权重，
 * 并把 tfjs 拆成运行时才加载的独立 chunk。浏览器里两处都要接管：
 *
 * 1. 权重与模型结构：不能走 node 的 `fs`，改成把资源内联成 data URL 后 fetch；
 * 2. tfjs chunk：webpack 的 node chunk 加载器用**同步** `require`，
 *    浏览器里没有这个函数。这里预先静态导入该 chunk，再把全局 `require`
 *    指向它，webpack 运行时就拿到同步的 chunk 内容。
 *
 * 置信度与候选选择在 `filesLanguageDetectionConfidence.ts`（纯函数，可单测）。
 * 模型加载失败时回传空结果，调用方按「没有结论」处理。
 */

/** 预导入的 webpack chunk：tfjs 的 CPU 后端。 */
const languageDetectionChunkExports =
  (languageDetectionChunk as { default?: { modules?: Record<string, unknown> } } | undefined)
    ?.default ?? (languageDetectionChunk as unknown as { modules?: Record<string, unknown> });

function installWebpackChunkLoader(): void {
  // 浏览器里没有全局 require；Node 环境下已有 require，不该覆盖。
  const target = globalThis as unknown as { require?: (id: string) => unknown };
  if (typeof target.require === "function") {
    return;
  }
  target.require = (id: string) => {
    // 包内只有 tfjs 这一个运行时 chunk，命中即返回预导入的 chunk 内容。
    if (id.endsWith(".js") && languageDetectionChunkExports?.modules) {
      return languageDetectionChunkExports;
    }
    throw new Error(`[files-language-detection] 不支持的 require: ${id}`);
  };
}

installWebpackChunkLoader();

interface DetectRequest {
  type: "detect";
  seq: number;
  content: string;
}

let modelOperations: ModelOperations | undefined;
let modelLoadFailed = false;

async function getModelOperations(): Promise<ModelOperations | undefined> {
  if (modelOperations) return modelOperations;
  if (modelLoadFailed) return undefined;
  try {
    const operations = new ModelOperations({
      modelJsonLoaderFunc: async () => {
        const response = await fetch(modelJsonUrl);
        if (!response.ok) throw new Error(`model.json ${response.status}`);
        return (await response.json()) as never;
      },
      weightsLoaderFunc: async () => {
        const response = await fetch(weightsUrl);
        if (!response.ok) throw new Error(`weights ${response.status}`);
        return await response.arrayBuffer();
      },
    });
    modelOperations = operations;
    return operations;
  } catch (error) {
    modelLoadFailed = true;
    console.warn("[files-language-detection] 模型加载失败，关闭内容级检测", error);
    return undefined;
  }
}

self.onmessage = async (event: MessageEvent<DetectRequest>) => {
  const request = event.data;
  if (request?.type !== "detect" || typeof request.seq !== "number") {
    return;
  }
  const operations = await getModelOperations();
  if (!operations) {
    self.postMessage({ type: "result", seq: request.seq, languageId: undefined });
    return;
  }
  try {
    const results = (await operations.runModel(
      request.content,
    )) as FilesLanguageDetectionCandidate[];
    const languageId = selectFilesDetectedLanguage(results ?? [], request.content);
    self.postMessage({ type: "result", seq: request.seq, languageId });
  } catch (error) {
    console.warn("[files-language-detection] 模型推理失败", error);
    self.postMessage({ type: "result", seq: request.seq, languageId: undefined });
  }
};

export {};

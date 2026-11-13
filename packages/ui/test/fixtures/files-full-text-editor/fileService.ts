import { FILE_TEXT_WINDOW_MAX_BYTES } from "@zcode/shared";
import type { CommitTextFileParams, CommitTextFileResult, FileTextWindow } from "@zcode/shared";

/**
 * 浏览器侧的服务边界：用同源 HTTP 调用夹具进程内的「磁盘」。
 *
 * 生产代码（readFilesTextForOpen / filesEditorStore / FilesEditorGroupPane /
 * FilesMonacoEditor / saveFilesTextBuffer）全部保持真实；这里只模拟
 * `IFileService.readTextFileWindow` 与 `commitTextFile` 的 typed RPC 形态。
 */

function errorWithCode(message: string, code: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

async function readError(response: Response): Promise<Error & { code?: string }> {
  let payload: { code?: string; message?: string } = {};
  try {
    payload = await response.json();
  } catch {
    // 服务端非 JSON 错误时保留 HTTP 状态，仍按失败处理。
  }
  const code = payload.code ?? (response.status === 404 ? "ENOENT" : undefined);
  const error = new Error(payload.message ?? `fixture file service ${response.status}`);
  return code ? Object.assign(error, { code }) : error;
}

export const fixtureFileService = {
  async readTextFileWindow(params: {
    path: string;
    offset?: number;
    length?: number;
    expectedVersion?: string;
  }): Promise<FileTextWindow> {
    const search = new URLSearchParams({
      path: params.path,
      offset: String(params.offset ?? 0),
      length: String(params.length ?? FILE_TEXT_WINDOW_MAX_BYTES),
    });
    if (params.expectedVersion !== undefined) {
      search.set("expectedVersion", params.expectedVersion);
    }
    const response = await fetch(`/__fixture/window?${search.toString()}`, {
      cache: "no-store",
    });
    if (!response.ok) {
      throw await readError(response);
    }
    return (await response.json()) as FileTextWindow;
  },

  async commitTextFile(params: CommitTextFileParams): Promise<CommitTextFileResult> {
    const response = await fetch("/__fixture/commit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
    });
    if (!response.ok) {
      throw await readError(response);
    }
    return (await response.json()) as CommitTextFileResult;
  },
};

export { errorWithCode };

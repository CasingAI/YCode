import type { IServiceAccessor } from "@zcode/services";
import type { FilesResolutionIO } from "@/files-workbench/filesMonacoTypescriptModuleResolve.js";

/** Avoid loading very large generated bundles/declaration files into Monaco's TS worker. */
export const FILES_MONACO_TYPESCRIPT_MAX_FILE_BYTES = 1024 * 1024;

function isMissingPathError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\bENOENT\b|no such file|not found|does not exist|cannot find the path/i.test(message);
}

export function createFilesMonacoTypescriptResolverIO(
  services: IServiceAccessor,
): FilesResolutionIO {
  const fileService = services.fileService;
  return {
    async stat(path) {
      try {
        const result = await fileService.stat({ path });
        return { kind: result.type === "directory" ? "folder" : "file" };
      } catch (error) {
        if (isMissingPathError(error)) return undefined;
        throw error;
      }
    },
    async list(path) {
      const entries = await fileService.readdir({ path, includeHidden: true });
      return entries.map((entry) => ({
        name: entry.name,
        kind: entry.type === "directory" ? "folder" : "file",
      }));
    },
    async readText(path) {
      let stat;
      try {
        stat = await fileService.stat({ path });
      } catch (error) {
        if (isMissingPathError(error)) throw new Error(`ENOENT: ${path}`);
        throw error;
      }
      if (stat.type !== "file") throw new Error("typescript-resolver-not-a-file");
      if (typeof stat.size === "number" && stat.size > FILES_MONACO_TYPESCRIPT_MAX_FILE_BYTES) {
        throw new Error("typescript-resolver-file-too-large");
      }
      const slice = await fileService.readTextFile({
        path,
        length: FILES_MONACO_TYPESCRIPT_MAX_FILE_BYTES,
      });
      if (slice.isBinary || slice.truncated) {
        throw new Error("typescript-resolver-file-not-complete-text");
      }
      return slice.content;
    },
  };
}

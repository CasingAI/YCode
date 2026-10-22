/**
 * 共享草稿的落盘实现。
 *
 * 按工作区分文件：`{appConfigDir}/composer-drafts/<hash>.json`。
 * 分文件而不是一个大文件，是因为草稿写入频繁（每次输入停顿都会写），
 * 单文件每次都要重写全部工作区的草稿，代价随工作区数量线性上升。
 *
 * 落盘内容是草稿正文，属于用户数据：只落本地，不进 setting.json，
 * 也不跟随通用配置导出与迁移。
 */
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { atomicWriteText } from "../fs/atomicFileUtils.js";
import { createServiceLogger } from "../logger/serviceLogger.js";
import { getAppConfigDir } from "../paths.js";
import type { ComposerDraftScope } from "./composerDraft.js";
import type { ComposerDraftStore, StoredComposerDraft } from "./composerDraftService.js";

const logger = createServiceLogger("composerDraftStore");

const storedDraftSchema = z.object({
  payload: z.unknown(),
  updatedAt: z.number().finite(),
  clientId: z.string().min(1),
});

const draftFileSchema = z.object({
  version: z.literal(1),
  scopes: z.record(z.string(), storedDraftSchema),
});

/** 单个工作区最多保留多少条草稿：超出后按 updatedAt 淘汰最旧的。 */
const MAX_SCOPES_PER_WORKSPACE = 50;

export function resolveComposerDraftDir(): string {
  return join(getAppConfigDir(), "composer-drafts");
}

/**
 * 工作区键 → 文件名。
 *
 * 工作区键可能是很长的路径，不能直接当文件名；取 sha256 前 16 位十六进制即可，
 * 冲突概率在本机规模下可以忽略，且不泄漏路径内容。
 */
function resolveWorkspaceFileName(workspaceKey: string): string {
  return `${createHash("sha256").update(workspaceKey).digest("hex").slice(0, 16)}.json`;
}

export function createFileComposerDraftStore(
  directory: string = resolveComposerDraftDir(),
): ComposerDraftStore {
  function resolveFilePath(scope: ComposerDraftScope): string {
    return join(directory, resolveWorkspaceFileName(scope.workspaceKey));
  }

  async function readFileScopes(filePath: string) {
    let raw: string;
    try {
      raw = await readFile(filePath, "utf-8");
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") {
        return {} as Record<string, StoredComposerDraft>;
      }
      logger.warn(undefined, "read composer draft file failed:", error);
      return {} as Record<string, StoredComposerDraft>;
    }
    try {
      const parsed = draftFileSchema.parse(JSON.parse(raw));
      return parsed.scopes;
    } catch (error) {
      // 坏文件按"没有草稿"处理：宁可丢掉历史草稿，也不要卡住 composer。
      logger.warn(undefined, "invalid composer draft file, treating as empty:", error);
      return {} as Record<string, StoredComposerDraft>;
    }
  }

  async function writeFileScopes(
    filePath: string,
    scopes: Record<string, StoredComposerDraft>,
  ): Promise<void> {
    const serialized = draftFileSchema.parse({ version: 1, scopes });
    await mkdir(dirname(filePath), { recursive: true });
    await atomicWriteText(filePath, `${JSON.stringify(serialized, null, 2)}\n`);
  }

  return {
    async read(scope) {
      const scopes = await readFileScopes(resolveFilePath(scope));
      return scopes[scope.scopeId] ?? null;
    },

    async write(scope, draft) {
      const filePath = resolveFilePath(scope);
      const scopes = await readFileScopes(filePath);
      scopes[scope.scopeId] = storedDraftSchema.parse(draft);
      // 超出上限时淘汰最旧的：草稿只服务于"下次接着写"，历史价值有限。
      const overflow = Object.keys(scopes).length - MAX_SCOPES_PER_WORKSPACE;
      if (overflow > 0) {
        const oldest = Object.entries(scopes)
          .sort((left, right) => left[1].updatedAt - right[1].updatedAt)
          .slice(0, overflow);
        for (const [scopeId] of oldest) {
          delete scopes[scopeId];
        }
      }
      await writeFileScopes(filePath, scopes);
    },

    async remove(scope) {
      const filePath = resolveFilePath(scope);
      const scopes = await readFileScopes(filePath);
      if (!(scope.scopeId in scopes)) {
        return;
      }
      delete scopes[scope.scopeId];
      await writeFileScopes(filePath, scopes);
    },
  };
}

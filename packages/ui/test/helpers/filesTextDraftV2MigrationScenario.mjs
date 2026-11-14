/**
 * 真实浏览器 IndexedDB v2 -> v3 迁移场景（供 files-full-text-editor fixture 合入）。
 *
 * 不伪造空库：先用 page.evaluate 在真实 Chromium IndexedDB 中创建 v2 数据库
 * 并写入一条完整 v2 草稿，随后让生产恢复 / 持久化链路打开同一数据库触发升级。
 * 场景只依赖夹具已暴露的 mount / activeTextBuffer / persistNow / draftParts。
 */

export const LEGACY_DRAFT_DB_NAME = "zcode-files-text-drafts";
export const LEGACY_DRAFT_STORE_NAME = "drafts";
export const LEGACY_SESSION_STORAGE_KEY = "zcode-files-editor-session-v1";

function draftStorageKey(workspaceKey, path) {
  return [workspaceKey, "", path].join("\u0000");
}

/**
 * 在真实浏览器里删除旧库并种入 v2 完整草稿，同时写入只有标签的 localStorage 会话。
 * 返回后续断言需要的身份与 storageKey。
 */
export async function seedLegacyV2Draft(
  page,
  {
    path,
    draftText,
    savedText,
    updatedAt = 1_000,
    workspace = {
      workspacePath: "/workspace/e2e",
      workspaceIdentity: "ws-e2e",
    },
  },
) {
  const workspaceKey = workspace.workspaceIdentity.trim() || workspace.workspacePath;
  const bufferId = `file:${workspaceKey}:${path}`;
  const storageKey = draftStorageKey(workspaceKey, path);

  await page.evaluate(
    async ({
      databaseName,
      storeName,
      sessionStorageKey,
      workspace: seededWorkspace,
      workspaceKey: seededWorkspaceKey,
      bufferId: seededBufferId,
      storageKey: seededStorageKey,
      path: seededPath,
      draftText: seededDraftText,
      savedText: seededSavedText,
      updatedAt: seededUpdatedAt,
    }) => {
      const deleted = new Promise((resolveDelete) => {
        const deletion = indexedDB.deleteDatabase(databaseName);
        deletion.onsuccess = () => resolveDelete();
        deletion.onerror = () => resolveDelete();
        deletion.onblocked = () => setTimeout(resolveDelete, 5_000);
      });
      await deleted;

      await new Promise((resolveWrite, rejectWrite) => {
        const request = indexedDB.open(databaseName, 2);
        request.onupgradeneeded = () => {
          request.result.createObjectStore(storeName, { keyPath: "storageKey" });
        };
        request.onerror = () => rejectWrite(request.error);
        request.onsuccess = () => {
          const database = request.result;
          const transaction = database.transaction(storeName, "readwrite");
          transaction.oncomplete = () => {
            database.close();
            resolveWrite();
          };
          transaction.onerror = () => rejectWrite(transaction.error);
          transaction.objectStore(storeName).put({
            schemaVersion: 2,
            bufferId: seededBufferId,
            path: seededPath,
            title: seededPath.split("/").at(-1) ?? seededPath,
            storageKey: seededStorageKey,
            workspaceKey: seededWorkspaceKey,
            remoteSessionId: "",
            text: seededDraftText,
            savedText: seededSavedText,
            workspace: seededWorkspace,
            untitled: false,
            updatedAt: seededUpdatedAt,
          });
        };
      });

      window.localStorage.setItem(
        sessionStorageKey,
        JSON.stringify({
          version: 1,
          explorerWorkspaceKey: seededWorkspaceKey,
          activeId: seededBufferId,
          openFileIds: [seededBufferId],
          openTabs: [
            {
              id: seededBufferId,
              kind: "text",
              path: seededPath,
              workspace: seededWorkspace,
            },
          ],
          // 超预算草稿的正常冷启动形态：localStorage 只有标签，正文在 IndexedDB。
          drafts: [],
        }),
      );
    },
    {
      databaseName: LEGACY_DRAFT_DB_NAME,
      storeName: LEGACY_DRAFT_STORE_NAME,
      sessionStorageKey: LEGACY_SESSION_STORAGE_KEY,
      workspace,
      workspaceKey,
      bufferId,
      storageKey,
      path,
      draftText,
      savedText,
      updatedAt,
    },
  );

  return { bufferId, storageKey, draftText, savedText };
}

/**
 * 执行迁移场景：v2 草稿恢复 -> 生产 persist 触发 v3 拆分 -> 再次恢复 v3 正文。
 *
 * 必须在页面尚未挂载 Workbench 时调用；ctx 至少提供 page / mount / waitFor /
 * confirm / activeTextBuffer / shot。
 */
export async function runFilesTextDraftV2MigrationScenario(ctx, options) {
  const { page, mount, waitFor, confirm, activeTextBuffer, bufferTokens, shot } = ctx;
  const path = options?.path ?? "/workspace/e2e/e2e-v2-migration.json";
  const marker = "V2_V3_MIGRATION_MARKER_7f3c";
  const draftText = `${"x".repeat(1_200_000)}${marker}`;
  const savedText = "v2 saved baseline";

  await page.evaluate(() => window.__fullTextE2E.clearStorage());
  const seeded = await seedLegacyV2Draft(page, { path, draftText, savedText, updatedAt: 1_000 });

  // 生产恢复链路打开真实 v2 库，触发 v2 -> v3 upgrade，并从 v2 整条记录恢复。
  await mount("restore");
  const restored = await waitFor(
    async () => {
      const buffer = await activeTextBuffer();
      return buffer && buffer.textLength === draftText.length && buffer.dirty === true
        ? buffer
        : undefined;
    },
    "v2 完整草稿恢复到 Store",
    30_000,
  );
  confirm("migration: v2 草稿长度完整恢复", restored.textLength === draftText.length, restored);
  await shot("migration-01-v2-restored");

  // 生产 persist 促使旧 v2 整条记录原子拆分为 metadata + bodies + baselines。
  await page.evaluate(() => window.__fullTextE2E.persistNow());
  const parts = await waitFor(
    async () => {
      const current = await page.evaluate(() => window.__fullTextE2E.draftParts());
      return current.bodies.length === 1 && current.baselines.length === 1 ? current : undefined;
    },
    "v2 记录升级为 v3 三 store",
    60_000,
  );
  const metadata = parts.drafts.find((draft) => draft.storageKey === seeded.storageKey);
  const body = parts.bodies.find((part) => part.storageKey === seeded.storageKey);
  const baseline = parts.baselines.find((part) => part.storageKey === seeded.storageKey);

  confirm("migration: drafts 元数据存在", Boolean(metadata), parts.drafts);
  confirm("migration: drafts 不再保存完整正文", metadata?.hasText === false, metadata);
  confirm("migration: drafts 不再保存完整 savedText", metadata?.hasSavedText === false, metadata);
  confirm("migration: bodies 正文长度完整", body?.textLength === draftText.length, body);
  confirm(
    "migration: bodies revision 与 metadata 一致",
    body?.revision === metadata?.bodyRevision,
    {
      bodyRevision: body?.revision,
      metadataRevision: metadata?.bodyRevision,
    },
  );
  confirm(
    "migration: baselines revision 与 metadata 一致",
    baseline?.revision === metadata?.savedRevision,
    {
      baselineRevision: baseline?.revision,
      metadataRevision: metadata?.savedRevision,
    },
  );
  await shot("migration-02-v3-parts");

  // 再次冷启动必须只从 v3 parts 恢复正文，而不是依赖 drafts 中的旧 text。
  await mount("restore");
  const restoredV3 = await waitFor(
    async () => {
      const buffer = await activeTextBuffer();
      return buffer && buffer.textLength === draftText.length && buffer.dirty === true
        ? buffer
        : undefined;
    },
    "v3 parts 冷启动恢复完整草稿",
    30_000,
  );
  confirm(
    "migration: v3 冷启动恢复同一正文长度",
    restoredV3.textLength === draftText.length,
    restoredV3,
  );
  const tokens = await bufferTokens([marker]);
  confirm("migration: v3 恢复正文包含尾部标记", tokens?.[0]?.count === 1, tokens);
  await shot("migration-03-v3-restored");
}

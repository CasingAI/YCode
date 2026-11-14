import { useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

// 使用生产全局样式，让标签条 / 状态栏依赖的真实 Tailwind 工具类生效。
import "../../../src/styles.css";
import "./fixture.css";

import { FilesEditorStoreProvider } from "@/files-workbench/FilesEditorStoreProvider.js";
import { FILES_TEXT_DRAFT_DB_NAME } from "@/files-workbench/filesTextDraftStorage.js";
import type { MountMode } from "./probes.js";
import { Workbench } from "./workbench.js";

/**
 * 隔离夹具入口：真实 FilesEditorGroupPane + 真实 filesEditorStore +
 * 真实 FilesMonacoEditor（从 monaco-editor 打包）+ 生产打开 / 保存 / 恢复链路。
 *
 * 只替换 i18n、settings、toast、logger、应用 store、平台与非文本预览分支。
 * 不提供替代编辑器，也不在夹具里重写读取决策或编辑逻辑；工作台与探针实现
 * 分别在 `workbench.tsx` / `probeReads.ts` / `probeRuntime.ts`。
 */

function App() {
  const [request, setRequest] = useState<{ key: number; mode: MountMode } | null>(null);
  const keyRef = useRef(0);

  useLayoutEffect(() => {
    window.__fullTextE2E ??= {};
    window.__fullTextE2E.saveEvents = [];
    window.__fullTextE2E.logs = [];
    window.__fullTextE2E.toasts = [];
    window.__fullTextE2E.mount = (options) => {
      keyRef.current += 1;
      window.__fullTextE2E!.saveEvents = [];
      window.__fullTextE2E!.logs = [];
      window.__fullTextE2E!.toasts = [];
      setRequest({ key: keyRef.current, mode: options?.mode ?? "fresh" });
    };
    window.__fullTextE2E.clearStorage = async () => {
      window.localStorage.clear();
      await new Promise<void>((resolveDelete) => {
        const factory = globalThis.indexedDB;
        if (!factory) {
          resolveDelete();
          return;
        }
        const deletion = factory.deleteDatabase(FILES_TEXT_DRAFT_DB_NAME);
        deletion.onsuccess = () => resolveDelete();
        deletion.onerror = () => resolveDelete();
        deletion.onblocked = () => {
          // 旧连接的 versionchange 会关闭数据库，删除随后继续；这里不提前返回。
        };
        setTimeout(resolveDelete, 5000);
      });
    };
  }, []);

  if (!request) return null;
  return (
    <FilesEditorStoreProvider key={request.key}>
      <Workbench mode={request.mode} />
    </FilesEditorStoreProvider>
  );
}

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("missing #root");
createRoot(rootElement).render(<App />);

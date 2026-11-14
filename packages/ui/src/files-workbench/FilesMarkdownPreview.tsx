import { useCallback, useMemo, useRef } from "react";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { MarkdownPreviewContent } from "@/previewPaneMarkdownContent.js";
import { useZCodeStoreWithDefault } from "@/store/StoreProvider.js";
import { snapshotFilesTextBuffer } from "@/files-workbench/filesTextDocumentModel.js";
import type { FilesTextBuffer } from "@/files-workbench/filesEditorTypes.js";

/**
 * 文件工作台的 Markdown 预览。
 *
 * 只渲染 Files Editor Store 中当前缓冲的正文（含未保存编辑），不读盘，
 * 也不复制第二份正文。运行时正文在绑定的 Monaco 模型里，这里在预览渲染
 * 边界取一次显式快照；渲染复用 Side Pane 同一个 MarkdownPreviewContent。
 */
export function FilesMarkdownPreview({ buffer }: { buffer: FilesTextBuffer }) {
  const theme = useZCodeStoreWithDefault((state) => state.theme, "system");
  const codePreviewSettings = useZCodeStoreWithDefault(
    (state) => state.codePreviewSettings,
    DEFAULT_CODE_PREVIEW_SETTINGS,
  );
  // 没有宿主平台时（测试 / 纯 Web 预览）不注册外链回调，避免渲染一个点了没反应的链接。
  const platform = useOptionalPlatform();
  const openExternal = useCallback((url: string) => platform?.openExternal(url), [platform]);
  // 缓冲对象每次状态更新都会换引用；快照只在正文代次 / 正文快照真正变化时重取，
  // 否则任一无关字段更新都会复制一遍全文。
  const bufferRef = useRef(buffer);
  bufferRef.current = buffer;
  const content = useMemo(
    () => snapshotFilesTextBuffer(bufferRef.current),
    [buffer.id, buffer.documentRevision, buffer.savedText, buffer.text],
  );
  return (
    <div
      data-files-markdown-preview=""
      data-buffer-id={buffer.id}
      className="h-full min-h-0 w-full"
    >
      <MarkdownPreviewContent
        content={content}
        workspacePath={buffer.workspace.workspacePath}
        theme={theme}
        codePreviewSettings={codePreviewSettings}
        onOpenBrowserUrl={platform ? openExternal : undefined}
      />
    </div>
  );
}

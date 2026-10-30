import { useCallback } from "react";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { MarkdownPreviewContent } from "@/previewPaneMarkdownContent.js";
import { useZCodeStoreWithDefault } from "@/store/StoreProvider.js";
import type { FilesTextBuffer } from "@/files-workbench/filesEditorTypes.js";

/**
 * 文件工作台的 Markdown 预览。
 *
 * 只渲染 Files Editor Store 中当前缓冲的正文（含未保存编辑），不读盘，
 * 也不复制第二份正文。渲染复用 Side Pane 同一个 MarkdownPreviewContent，
 * 因此 GFM、代码块、安全管线和主题都保持一致；不带聊天选区工具。
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
  return (
    <div
      data-files-markdown-preview=""
      data-buffer-id={buffer.id}
      className="h-full min-h-0 w-full"
    >
      <MarkdownPreviewContent
        content={buffer.text}
        workspacePath={buffer.workspace.workspacePath}
        theme={theme}
        codePreviewSettings={codePreviewSettings}
        onOpenBrowserUrl={platform ? openExternal : undefined}
      />
    </div>
  );
}

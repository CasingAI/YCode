// 只替换大文本查看器边界：本任务只验证大文本不出现 Markdown 模式切换。
export function FilesLargeTextViewer({ buffer }: { buffer?: { path?: string; title?: string } }) {
  return (
    <div data-testid="files-e2e-large-text-viewer" className="files-e2e-meta">
      large-text:{buffer?.path ?? buffer?.title}
    </div>
  );
}

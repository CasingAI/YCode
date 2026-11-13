// 只替换非法 UTF-8 / legacy 固定块分支；本场景验证合法完整正文，不会挂载该视图。
export function FilesLargeTextViewer({ buffer }: { buffer?: { path?: string; title?: string } }) {
  return (
    <div data-testid="files-e2e-large-text-viewer">
      large-text:{buffer?.path ?? buffer?.title}
    </div>
  );
}

// 只替换非 Markdown/二进制预览服务边界；Markdown 预览组件保持生产实现。
export function PreviewPane({
  source,
  onClose,
}: {
  source?: { title?: string; path?: string };
  onClose?: () => void;
}) {
  return (
    <div data-testid="files-e2e-preview-pane" className="files-e2e-meta">
      preview:{source?.path ?? source?.title}
      <button type="button" onClick={onClose}>
        close
      </button>
    </div>
  );
}

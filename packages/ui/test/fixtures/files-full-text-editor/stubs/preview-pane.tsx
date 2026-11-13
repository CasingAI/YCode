// 只替换二进制 / 图片等非文本预览分支；完整正文的 Monaco 分支保持生产实现。
export function PreviewPane({ source }: { source?: { title?: string; path?: string } }) {
  return <div data-testid="files-e2e-preview-pane">preview:{source?.path ?? source?.title}</div>;
}

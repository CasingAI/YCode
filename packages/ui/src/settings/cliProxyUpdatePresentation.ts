/** CLI Proxy 更新提示的纯展示逻辑（无 IO，可单测）。 */

/** 按当前 locale 与本地时区格式化 lastUpdateCheckAt（ISO 字符串）。 */
export function formatCliProxyLastCheckAt(iso: string, locale: string): string {
  const time = new Date(iso).toLocaleString(locale || undefined);
  return time;
}

/** 下载进度百分比；totalBytes 为 null 时返回 null（不确定进度）。 */
export function cliProxyDownloadPercent(
  receivedBytes: number,
  totalBytes: number | null,
): number | null {
  if (totalBytes == null || totalBytes <= 0) return null;
  return Math.min(100, Math.max(0, (receivedBytes / totalBytes) * 100));
}

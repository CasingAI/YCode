// 站外链接的唯一事实源：新增入口时先在这里登记，避免同一个地址散落在多处。
export const REPOSITORY_URL = "https://github.com/CasingAI/YCode";
// 下载入口用 /releases/latest，始终指向当前最新版，不写死某个 tag。
export const RELEASE_URL = `${REPOSITORY_URL}/releases/latest`;
export const UPSTREAM_URL = "https://github.com/zai-org/ZCode";

export type DownloadAsset = {
  platform: string;
  arch: string;
  url: string;
};

// 当前版本的安装包直链：发版时与 changelog.ts 一起更新。
// 各平台的构建号不一定相同，所以按 Release 页面上实际的产物名逐个登记；
// 清单里没有的平台不在菜单里出现，也不要凭文件名规则去猜地址。
const RELEASE_TAG = "v4.0";

function assetUrl(name: string): string {
  return `${REPOSITORY_URL}/releases/download/${RELEASE_TAG}/${name}`;
}

export const DOWNLOAD_ASSETS: DownloadAsset[] = [
  { platform: "macOS", arch: "Apple 芯片", url: assetUrl("YCode-4.0.140-mac-arm64.dmg") },
  { platform: "macOS", arch: "Intel", url: assetUrl("YCode-4.0.139-mac-x64.dmg") },
  { platform: "Windows", arch: "x64", url: assetUrl("YCode-4.0.138-win-x64.exe") },
];

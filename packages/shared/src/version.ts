// 由各 bundler 通过 define 注入，避免运行时 JSON import 的跨 bundler 兼容问题。
// 非构建环境（如 e2e 测试的 mocha）下 define 不存在，
// 用 typeof 检查 + fallback 避免 ReferenceError。
declare const __ZCODE_VERSION__: string;
declare const __ZCODE_UPSTREAM_VERSION__: string;
declare const __ZCODE_COMMIT__: string;
declare const __ZCODE_BUILD_TIME__: string;
declare const __ZCODE_EXPECTED_CLI_VERSION__: string;

export const ZCODE_VERSION: string =
  typeof __ZCODE_VERSION__ !== "undefined" ? __ZCODE_VERSION__ : "0.0.0-dev";
// 本发行版对齐的上游 ZCode 版本，只写进出站 UA 的 `(like ZCode/x)` 段。
// 独立于 ZCODE_VERSION：两者不联动、不互相推导，改一个不动另一个。
// 默认值与根 package.json 的 zcodeUpstreamVersion 保持一致，供 CLI 与 dev 无 define 时兜底。
export const ZCODE_UPSTREAM_VERSION: string =
  typeof __ZCODE_UPSTREAM_VERSION__ !== "undefined" ? __ZCODE_UPSTREAM_VERSION__ : "3.11.2";
export const ZCODE_COMMIT: string =
  typeof __ZCODE_COMMIT__ !== "undefined" ? __ZCODE_COMMIT__ : "unknown";
export const ZCODE_BUILD_TIME: string =
  typeof __ZCODE_BUILD_TIME__ !== "undefined" ? __ZCODE_BUILD_TIME__ : "unknown";
// 桌面编译把同一次构建暂存的 CLI sidecar 版本打进 Host。空串表示未绑定，沿用原解析链。
export const ZCODE_EXPECTED_CLI_VERSION: string =
  typeof __ZCODE_EXPECTED_CLI_VERSION__ !== "undefined" ? __ZCODE_EXPECTED_CLI_VERSION__ : "";

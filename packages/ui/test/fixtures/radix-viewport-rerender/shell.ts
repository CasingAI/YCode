/**
 * 根据 URL 参数选择 ESM 或 CJS 的 Radix 包入口。
 *
 * 两个入口都静态导入，Vite 会分别产出独立 chunk；测试用 `?entry=esm|cjs`
 * 决定加载哪一个，避免两个入口同时挂载互相干扰。
 */
const params = new URLSearchParams(window.location.search);

if (params.get("entry") === "cjs") {
  await import("./entry-cjs.js");
} else {
  await import("./entry-esm.js");
}

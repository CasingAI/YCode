/**
 * fixture 页面骨架与「启动前就绪」的产品 CSS 注入片段（P0-2 修正）。
 *
 * 旧口径在页面 mount 之后才从 live DOM 收集 class 并生成 tailwind CSS：
 * 首绘 staging 容器里的类（`invisible` / `bottom-full` / `pointer-events-none`）在收集时
 * 还没上屏，于是首绘必然在缺样式状态下排版。现在由 Build 静态扫描当前 src + 快照 src
 * 生成完整产品 CSS，模块在 bundle 求值时就注入 `<style data-cost-product-css>`，
 * 早于任何 React mount 与首绘 staging。
 */

/** 产品 CSS 模块在 outDir 中的文件名（Build 写入，fixture 入口导入）。 */
export const PRODUCT_CSS_MODULE = "layout-cost-product-css.ts";

/** 产品 CSS 在页面里的标记，用于断言「启动前已有产品样式」。 */
export const PRODUCT_CSS_STYLE_ATTRIBUTE = "data-cost-product-css";

/**
 * fixture 入口顶部的 CSS 注入片段。
 *
 * esbuild 的静态 import 会提升到模块求值之前，因此这段代码执行时 `PRODUCT_CSS`
 * 已经完整可用；插入 `<style>` 发生在 `createRoot` 之前。
 */
export function installProductCssImport(): string {
  return [
    `import { PRODUCT_CSS } from "./${PRODUCT_CSS_MODULE.replace(/\.ts$/, ".js")}";`,
    'if (typeof document !== "undefined" && document.head) {',
    `  if (!document.head.querySelector("[${PRODUCT_CSS_STYLE_ATTRIBUTE}]")) {`,
    '    const style = document.createElement("style");',
    `    style.setAttribute("${PRODUCT_CSS_STYLE_ATTRIBUTE}", "1");`,
    "    style.textContent = PRODUCT_CSS;",
    "    document.head.appendChild(style);",
    "  }",
    "}",
    "",
  ].join("\n");
}

/**
 * 页面骨架只保留 fixture 自身的容器尺寸与基础字体。
 *
 * 产品样式由 bundle 求值时注入的完整产品 CSS 提供；这里不重复声明任何组件样式，
 * 避免出现「骨架补丁冒充产品样式」的假通过。
 */
export const LAYOUT_COST_PAGE_SKELETON = `<!doctype html><html><head><style>
html,body,#root{height:100%;margin:0;padding:0}
body{font:14px/20px system-ui,sans-serif;background:#fff;color:#111}
[data-cost-host]{height:100%}
[data-testid="v4-timeline"]{flex:1 1 0;min-height:0;overflow-y:auto;overflow-x:hidden}
section[data-turn-id]{min-height:40px}
button{font:inherit;padding:2px 6px}
[data-cost-root="toolbar"],[data-cost-root="sidepane"]{box-sizing:border-box}
</style></head><body><div id="root"></div></body></html>`;

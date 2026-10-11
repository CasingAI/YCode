/**
 * node:test 的资源 stub loader。
 *
 * UI 源码里有静态资源 import（`@/lib/pluginIconSource.ts` 引 `@/assets/plugin-icons/*.png`），
 * Node 的 ESM loader 不认识 `.png`，直接跑测试会在加载期报 ERR_UNKNOWN_FILE_EXTENSION。
 * 这些资源只在浏览器构建里参与渲染，node 侧一律 stub 成字符串即可，不影响被测逻辑。
 *
 * 用法：`npx tsx --import ./test/helpers/registerAssetStubs.mjs --test <file>`
 * 或直接用 `pnpm --filter @zcode/ui test`。
 */
export async function resolve(specifier, context, next) {
  if (/\.(png|jpe?g|gif|webp|svg|woff2?|mp3|wav|ogg|m4a)$/i.test(specifier)) {
    // 按导入路径区分 stub：同一文件的多次导入拿到同一字符串，不同文件拿到不同字符串。
    // 纯字符串比较不断言真实文件名，只保证“不同素材可区分、相同素材稳定”。
    return {
      url: `data:text/javascript,export default "asset-stub:${specifier}";`,
      shortCircuit: true,
    };
  }
  return next(specifier, context);
}

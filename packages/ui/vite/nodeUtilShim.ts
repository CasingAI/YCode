/**
 * 浏览器端的 `util` 垫片。
 *
 * 背景：语言检测模型用的 `@vscode/vscode-languagedetection` 是 webpack
 * `target: 'node'` 的产物，内部引入了 tfjs 的 platform_node 分支，
 * 那里会读 `util.TextEncoder` / `util.TextDecoder`。Vite 默认把 node 内置
 * 模块外部化成空壳，运行时 `new util.TextEncoder()` 会抛
 * 「this.util.TextEncoder is not a constructor」，模型直接加载失败。
 *
 * 这里只提供 tfjs 实际用到的能力：文本编解码、promisify、inspect。
 * 别处没有依赖 node 的 util（仓库内没有任何 `from "util"`），
 * 因此这个别名不会影响其它代码。
 */
export const TextEncoder = globalThis.TextEncoder;
export const TextDecoder = globalThis.TextDecoder;

export function promisify<T extends (...args: never[]) => unknown>(
  fn: T,
): (...args: Parameters<T>) => Promise<ReturnType<T>> {
  return (...args: Parameters<T>) =>
    new Promise((resolve, reject) => {
      try {
        // @ts-expect-error 运行时按 node 风格回调处理
        fn(...args, (error: unknown, value: unknown) => {
          if (error) reject(error);
          else resolve(value);
        });
      } catch (error) {
        reject(error);
      }
    });
}

export function inspect(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export default { TextEncoder, TextDecoder, promisify, inspect };

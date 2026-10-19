declare module "@vscode/vscode-languagedetection/dist/lib/979.js" {
  /**
   * `@vscode/vscode-languagedetection` 产物里由 webpack 拆出的运行时 chunk
   * （tfjs 的 CPU 后端）。包的 node 运行时用同步 `require` 加载它，
   * 浏览器里改为静态预导入，详见 filesLanguageDetection.worker.ts。
   */
  const chunk: {
    id: number;
    ids: number[];
    modules: Record<string, unknown>;
  };
  export default chunk;
}

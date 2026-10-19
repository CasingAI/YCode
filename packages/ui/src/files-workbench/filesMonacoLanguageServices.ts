/**
 * Monaco 0.57 把 TS/JSON 默认项从 languages.* 挪到了包顶层 typescript / json。
 * 工作台会按当前工作区注入源码/声明并配置 paths；语义诊断仍保持关闭，
 * 因为 Monaco 的 TS defaults 是全局的，多工作区并排时无法为每个模型单独设置 paths，
 * 默认诊断会对非焦点工作区的合法别名产生虚假红线。补全与定义跳转仍使用已注入的类型数据。
 */

export interface FilesMonacoLanguageServices {
  typescript: {
    typescriptDefaults: { setDiagnosticsOptions: (options: object) => void };
    javascriptDefaults: { setDiagnosticsOptions: (options: object) => void };
  };
  json: {
    jsonDefaults: { setDiagnosticsOptions: (options: object) => void };
  };
}

export const FILES_MONACO_TS_DIAGNOSTICS = {
  noSemanticValidation: true,
  noSuggestionDiagnostics: true,
  noSyntaxValidation: false,
};

export const FILES_MONACO_JSON_DIAGNOSTICS = {
  validate: true,
  allowComments: true,
  trailingCommas: "ignore",
};

export function configureFilesMonacoLanguageServices(monaco: FilesMonacoLanguageServices): void {
  monaco.typescript.typescriptDefaults.setDiagnosticsOptions(FILES_MONACO_TS_DIAGNOSTICS);
  monaco.typescript.javascriptDefaults.setDiagnosticsOptions(FILES_MONACO_TS_DIAGNOSTICS);
  monaco.json.jsonDefaults.setDiagnosticsOptions(FILES_MONACO_JSON_DIAGNOSTICS);
}

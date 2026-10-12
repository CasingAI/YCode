/**
 * 文件工作台的 Monaco 只做编辑与高亮，不接项目语言服务。
 * Monaco 0.57 把 TS/JSON 默认项从 languages.* 挪到了包顶层 typescript / json。
 * 语义诊断会按默认 moduleResolution 去解析 `@zcode/services/node` 这类别名，画出虚假红线。
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

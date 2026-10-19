import type * as Monaco from "monaco-editor";

export const FILES_MONACO_CUSTOM_LANGUAGE_IDS = ["jsonl", "makefile"] as const;

const JSONL_LANGUAGE: Monaco.languages.IMonarchLanguage = {
  tokenizer: {
    root: [
      [/[ \t\r]+/, "white"],
      [/"(?:[^"\\]|\\.)*"(?=\s*:)/, "string.key.json"],
      [/(?:"(?:[^"\\]|\\.)*")/, "string"],
      [/-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/, "number"],
      [/\b(?:true|false|null)\b/, "keyword"],
      [/[{}]|\[|\]/, "delimiter.bracket"],
      [/[,:]/, "delimiter"],
      [/[^\s]+/, "invalid"],
    ],
  },
};

const MAKEFILE_LANGUAGE: Monaco.languages.IMonarchLanguage = {
  tokenizer: {
    root: [
      [/^\t.*$/, "string"],
      [/^\s*#.*$/, "comment"],
      [
        /^\s*(?:-?include|sinclude|vpath|export|override|private|undefine|define|endef|ifeq|ifneq|ifdef|ifndef|else|endif)\b.*$/,
        "keyword",
      ],
      [/^\s*[A-Za-z0-9_./%$(){}-]+(?:::|:)(?:\s|$)/, "type.identifier"],
      [/^\s*[A-Za-z_][\w.-]*\s*(?::=|\+=|\?=|!=|=)/, "variable"],
      [/\$\([^)]*\)|\$\{[^}]*\}|\$\$/, "variable"],
      [/[|&;<>]/, "operator"],
      [/\\$/, "operator"],
      [/[^\s]+/, "identifier"],
    ],
  },
};

const JSONL_CONFIGURATION: Monaco.languages.LanguageConfiguration = {
  brackets: [
    ["{", "}"],
    ["[", "]"],
  ],
  autoClosingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: '"', close: '"' },
  ],
};

const MAKEFILE_CONFIGURATION: Monaco.languages.LanguageConfiguration = {
  comments: { lineComment: "#" },
  brackets: [
    ["(", ")"],
    ["{", "}"],
  ],
  autoClosingPairs: [
    { open: "(", close: ")" },
    { open: "{", close: "}" },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
  ],
};

/** Register custom IDs before any editor model is created; never return an unregistered language id. */
export function configureFilesMonacoCustomLanguages(monaco: typeof Monaco): void {
  const registered = new Set(monaco.languages.getLanguages().map((language) => language.id));
  if (!registered.has("jsonl")) {
    monaco.languages.register({
      id: "jsonl",
      extensions: [".jsonl", ".ndjson"],
      aliases: ["JSON Lines", "jsonl", "ndjson"],
    });
    monaco.languages.setMonarchTokensProvider("jsonl", JSONL_LANGUAGE);
    monaco.languages.setLanguageConfiguration("jsonl", JSONL_CONFIGURATION);
  }
  if (!registered.has("makefile")) {
    monaco.languages.register({
      id: "makefile",
      aliases: ["Makefile", "makefile", "GNUmakefile"],
    });
    monaco.languages.setMonarchTokensProvider("makefile", MAKEFILE_LANGUAGE);
    monaco.languages.setLanguageConfiguration("makefile", MAKEFILE_CONFIGURATION);
  }
}

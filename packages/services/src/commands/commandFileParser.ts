import {
  formatCommandFrontmatterModelSelection,
  parseCommandFrontmatterModelSelection,
  type CommandConfig,
  type ModelSelection,
} from "@zcode/shared";

export type CommandFileFormat = "markdown";

interface ParsedCommandFile {
  name: string;
  prompt: string;
  content: string;
  filePath: string;
  description?: string;
  argumentHint?: string;
  modelSelectionOverride?: ModelSelection;
}

interface MarkdownCommandParts {
  frontmatterLines: string[];
  contentLines: string[];
}

function getCrossPlatformBasename(filePath: string): string {
  return filePath.split(/[\\/]+/).pop() ?? "";
}

function splitMarkdownCommandContent(content: string): MarkdownCommandParts {
  const lines = content.split("\n");
  const frontmatterStart = lines.findIndex((line) => line.trim() === "---");
  const frontmatterEnd = lines.findIndex(
    (line, index) => index > frontmatterStart && line.trim() === "---",
  );

  if (frontmatterStart === -1 || frontmatterEnd === -1) {
    return { frontmatterLines: [], contentLines: lines };
  }

  return {
    frontmatterLines: lines.slice(frontmatterStart + 1, frontmatterEnd),
    contentLines: lines.slice(frontmatterEnd + 1),
  };
}

function readFrontmatterKey(line: string): string | undefined {
  if (line.startsWith(" ") || line.startsWith("\t")) {
    return undefined;
  }
  const match = /^([A-Za-z0-9_-]+)\s*:/.exec(line.trim());
  return match?.[1]?.toLowerCase();
}

function readFrontmatterMultilineValue(
  lines: readonly string[],
  targetKey: string,
): string | undefined {
  const collected: string[] = [];
  let collecting = false;

  for (const line of lines) {
    const key = readFrontmatterKey(line);
    if (key) {
      if (collecting) {
        break;
      }
      if (key === targetKey) {
        collecting = true;
        const value = line.split(":").slice(1).join(":").trim();
        if (value) {
          collected.push(value);
        }
      }
      continue;
    }

    if (collecting && (line.startsWith(" ") || line.startsWith("\t"))) {
      collected.push(line.trim());
    }
  }

  const value = collected.join(" ").trim();
  return value || undefined;
}

function preserveFrontmatterLines(
  existingContent: string | undefined,
  replacedKeys: ReadonlySet<string>,
): string[] {
  const preserved: string[] = [];
  let skipUntilNextKey = false;

  for (const line of splitMarkdownCommandContent(existingContent ?? "").frontmatterLines) {
    const key = readFrontmatterKey(line);
    if (key) {
      skipUntilNextKey = replacedKeys.has(key);
    }
    if (!skipUntilNextKey) {
      preserved.push(line);
    }
  }

  return preserved;
}

function parseMarkdownCommandFile(content: string, filePath: string): ParsedCommandFile | null {
  const { frontmatterLines, contentLines } = splitMarkdownCommandContent(content);
  const fileName = getCrossPlatformBasename(filePath);
  const name = `/${fileName.replace(/\.md$/i, "")}`;
  const prompt = contentLines.join("\n").trim();

  if (!name) {
    return null;
  }

  return {
    name,
    prompt,
    content: contentLines.join("\n"),
    filePath,
    description: readFrontmatterMultilineValue(frontmatterLines, "description"),
    argumentHint: readFrontmatterMultilineValue(frontmatterLines, "argument-hint"),
    modelSelectionOverride: parseCommandFrontmatterModelSelection(
      readFrontmatterMultilineValue(frontmatterLines, "model"),
      readFrontmatterMultilineValue(frontmatterLines, "model-effort"),
    ),
  };
}

function generateMarkdownCommandFileContent(
  config: CommandConfig,
  existingContent?: string,
): string {
  const replacedKeys = new Set<string>(["description", "argument-hint"]);
  const frontmatterLines = preserveFrontmatterLines(existingContent, replacedKeys);

  if (config.description?.trim()) {
    frontmatterLines.push(`description: ${config.description.trim()}`);
  }
  if (config.argumentHint?.trim()) {
    frontmatterLines.push(`argument-hint: ${config.argumentHint.trim()}`);
  }

  if (frontmatterLines.length === 0) {
    return config.prompt;
  }

  return `---
${frontmatterLines.join("\n")}
---

${config.prompt}`;
}

/**
 * 只重写文件头的 model / model-effort 两个键，其余行原样保留——
 * 绑定是行内控件的即改即存，不能顺带动用户手写的 description / prompt。
 */
function rewriteMarkdownModelFrontmatter(
  existingContent: string,
  modelSelection?: ModelSelection,
): string {
  const { contentLines } = splitMarkdownCommandContent(existingContent);
  const replacedKeys = new Set(["model", "model-effort"]);
  const preserved = preserveFrontmatterLines(existingContent, replacedKeys);

  if (modelSelection) {
    const { model, effort } = formatCommandFrontmatterModelSelection(modelSelection);
    preserved.push(`model: ${model}`);
    if (effort) {
      preserved.push(`model-effort: ${effort}`);
    }
  }

  const prompt = contentLines.join("\n").replace(/^\n+/, "");
  if (preserved.length === 0) {
    return prompt;
  }
  return `---
${preserved.join("\n")}
---

${prompt}`;
}

export class CommandFileParser {
  static parseCommandFile(
    content: string,
    filePath: string,
    _format: CommandFileFormat = "markdown",
  ): ParsedCommandFile | null {
    try {
      return parseMarkdownCommandFile(content, filePath);
    } catch {
      return null;
    }
  }

  static generateCommandFileContent(
    config: CommandConfig,
    _format: CommandFileFormat = "markdown",
    existingContent?: string,
  ): string {
    return generateMarkdownCommandFileContent(config, existingContent);
  }

  static rewriteModelFrontmatter(
    existingContent: string,
    modelSelection?: ModelSelection,
    _format: CommandFileFormat = "markdown",
  ): string {
    return rewriteMarkdownModelFrontmatter(existingContent, modelSelection);
  }
}

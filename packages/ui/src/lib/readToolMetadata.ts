import { joinFilePath } from "@/lib/path.js";

export type ReadEntryType = "file" | "directory";

export interface ReadToolMetadata {
  path?: string;
  fileName?: string;
  entryType: ReadEntryType;
}

type PartialReadMetadata = Partial<ReadToolMetadata>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readField(value: unknown, keys: readonly string[]): string | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return undefined;
}

function readEntryType(value: unknown): ReadEntryType | undefined {
  const type = readField(value, ["fileType", "entryType", "type"]);
  if (type && /^(?:dir|directory|folder|list_files)$/i.test(type)) return "directory";
  return type === "file" ? "file" : undefined;
}

function mergeMetadata(values: readonly PartialReadMetadata[]): PartialReadMetadata {
  return {
    path: values.find((value) => value.path)?.path,
    fileName: values.find((value) => value.fileName)?.fileName,
    entryType: values.find((value) => value.entryType)?.entryType,
  };
}

function readInputMetadata(input: unknown): PartialReadMetadata {
  const direct: PartialReadMetadata = {
    path: readField(input, ["filePath", "file_path", "path", "filename"]),
    fileName: readField(input, ["name"]),
    entryType: readEntryType(input),
  };
  if (!isRecord(input) || !Array.isArray(input.parsed_cmd)) return direct;
  const command = input.parsed_cmd.find(
    (value) => isRecord(value) && (value.type === "read" || value.type === "list_files"),
  );
  if (!command) return direct;
  const fileName = readField(command, ["name"]);
  const path = readField(command, ["filePath", "file_path", "path", "filename"]) ?? fileName;
  const cwd = readField(input, ["cwd"]);
  return mergeMetadata([
    direct,
    {
      path: path && cwd ? joinFilePath(cwd, path) : path,
      fileName,
      entryType: readEntryType(command),
    },
  ]);
}

function readOutputMetadata(output: unknown): PartialReadMetadata {
  if (typeof output === "string") {
    const path = output.match(/<path>([\s\S]*?)<\/path>/i)?.[1]?.trim();
    const type = output.match(/<type>([\s\S]*?)<\/type>/i)?.[1]?.trim();
    return { path: path || undefined, entryType: readEntryType({ type }) };
  }
  if (Array.isArray(output)) return mergeMetadata(output.map(readOutputMetadata));
  if (!isRecord(output)) return {};
  return mergeMetadata([
    {
      path: readField(output, ["filePath", "file_path", "path", "filename"]),
      fileName: readField(output, ["name"]),
      entryType: readEntryType(output),
    },
    ...[output.output, output.text, output.content].map(readOutputMetadata),
  ]);
}

export function readToolMetadata(
  input: unknown,
  raw?: unknown,
  output?: unknown,
): ReadToolMetadata {
  const rawRecord = isRecord(raw) ? raw : {};
  // 目录类型和路径可能分别来自输出与输入，不能因其中一个字段缺失而丢弃另一个。
  const metadata = mergeMetadata([
    readOutputMetadata(output),
    readOutputMetadata(rawRecord.rawOutput),
    readOutputMetadata(rawRecord.content),
    readOutputMetadata(rawRecord.rawOutputText),
    readInputMetadata(input),
    readInputMetadata(rawRecord.rawInput),
  ]);
  return { ...metadata, entryType: metadata.entryType ?? "file" };
}

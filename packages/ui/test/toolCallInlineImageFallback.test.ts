import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const toolCallBodyPath = new URL("../src/ToolCallBlocks/ToolCallBody.tsx", import.meta.url);
const [toolCallBody, zhCN, enUS] = await Promise.all([
  readFile(toolCallBodyPath, "utf8"),
  readFile(new URL("../src/i18n/locales/zh-CN.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/i18n/locales/en-US.ts", import.meta.url), "utf8"),
]);

test("内联图片预览失败会离开 loading 并区分缺失与一般错误", () => {
  assert.match(toolCallBody, /readMediaPreview\(\{ path: preview\.path \}\)[\s\S]*?\.catch\(/);
  assert.match(toolCallBody, /isMissingFileError\(error\)/);
  assert.match(toolCallBody, /codeViewer\.fileMissing/);
  assert.match(toolCallBody, /codeViewer\.mediaLoadFailed/);
  assert.match(toolCallBody, /data-tool-call-inline-image-state="missing"/);
  assert.match(toolCallBody, /data-tool-call-inline-image-state="failed"/);
});

test("图片与后台 Bash 缺失 fallback 均提供中英文文案", () => {
  assert.match(zhCN, /"bashOutput\.error\.missing": "输出文件不存在/);
  assert.match(enUS, /"bashOutput\.error\.missing":\s*"The output file does not exist/);
  assert.match(zhCN, /"codeViewer\.fileMissing": "文件不存在/);
  assert.match(enUS, /"codeViewer\.fileMissing": "The file does not exist/);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAssistantPreviewCardsFromReferences,
  extractAssistantFileReferences,
} from "../src/lib/assistantPreviewCards.js";

const WORKSPACE_PATH = "/workspace";

test("localhost 正文不会生成网站预览卡", () => {
  const content = [
    "升级地址：",
    "- http://localhost",
    "- http://localhost/cn",
    "- http://localhost/en",
    "- http://localhost/api/v1/client/configs",
    "- http://localhost/api/v1/releases/electron/manifest",
    "- http://127.0.0.1:4173/preview",
    "- [预览](http://localhost/cn)",
    "",
    "```text",
    "http://localhost/internal-route",
    "```",
  ].join("\n");

  const references = extractAssistantFileReferences(content, WORKSPACE_PATH);
  const cards = buildAssistantPreviewCardsFromReferences(WORKSPACE_PATH, references);

  assert.deepEqual(cards, []);
});

test("localhost URL 不会抑制真实文件卡", () => {
  const content = [
    "详见 http://localhost/api/v1/client/configs",
    "",
    "文件：`artifacts/report.pdf`",
  ].join("\n");
  const references = extractAssistantFileReferences(content, WORKSPACE_PATH);

  const cards = buildAssistantPreviewCardsFromReferences(WORKSPACE_PATH, references);

  assert.equal(cards.length, 1);
  assert.equal(cards[0]?.type, "file");
  assert.equal(cards[0]?.title, "report.pdf");
});

test("localhost URL 与真实 HTML 文件同时出现时只生成 HTML 卡", () => {
  const path = "artifacts/index.html";
  const references = extractAssistantFileReferences(
    `[服务](http://localhost:3000)；[文件](file://${WORKSPACE_PATH}/${path})`,
    WORKSPACE_PATH,
  );

  const cards = buildAssistantPreviewCardsFromReferences(WORKSPACE_PATH, references, {
    changedFilePaths: [path],
  });

  assert.equal(cards.length, 1);
  assert.equal(cards[0]?.type, "website");
  assert.equal(cards[0]?.title, "index.html");
  assert.equal(cards[0]?.filePath, `${WORKSPACE_PATH}/${path}`);
});

test("真实 Markdown 文件不再生成 Assistant 文档卡", () => {
  const path = "docs/specs/assistant-preview-cards.md";
  const references = extractAssistantFileReferences(`详见 \`${path}\`。`, WORKSPACE_PATH);

  const cards = buildAssistantPreviewCardsFromReferences(WORKSPACE_PATH, references, {
    changedFilePaths: [path],
  });

  assert.deepEqual(cards, []);
});

test("Markdown 与真实文件同时出现时只生成非 Markdown 文件卡", () => {
  const markdownPath = "docs/specs/assistant-preview-cards.md";
  const pdfPath = "artifacts/report.pdf";
  const references = extractAssistantFileReferences(
    `规范：\`${markdownPath}\`；报告：\`${pdfPath}\`。`,
    WORKSPACE_PATH,
  );

  const cards = buildAssistantPreviewCardsFromReferences(WORKSPACE_PATH, references, {
    changedFilePaths: [markdownPath, pdfPath],
  });

  assert.equal(cards.length, 1);
  assert.equal(cards[0]?.type, "file");
  assert.equal(cards[0]?.title, "report.pdf");
});

test("真实 HTML 文件仍生成 file website 卡", () => {
  const path = "artifacts/index.html";
  const references = extractAssistantFileReferences(
    `[预览](file://${WORKSPACE_PATH}/${path})`,
    WORKSPACE_PATH,
  );

  const cards = buildAssistantPreviewCardsFromReferences(WORKSPACE_PATH, references, {
    changedFilePaths: [path],
  });

  assert.equal(cards.length, 1);
  assert.equal(cards[0]?.type, "website");
  assert.equal(cards[0]?.title, "index.html");
  assert.equal(cards[0]?.filePath, `${WORKSPACE_PATH}/${path}`);
  assert.equal(cards[0]?.url.startsWith("file://"), true);
});

test("真实文件卡继续去重", () => {
  const path = "artifacts/report.pdf";
  const references = extractAssistantFileReferences(`报告：${path}，另见 ${path}`, WORKSPACE_PATH);

  const cards = buildAssistantPreviewCardsFromReferences(WORKSPACE_PATH, references);

  assert.equal(cards.length, 1);
  assert.equal(cards[0]?.type, "file");
  assert.equal(cards[0]?.title, "report.pdf");
});

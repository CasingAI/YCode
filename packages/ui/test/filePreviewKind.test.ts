import assert from "node:assert/strict";
import test from "node:test";
import { resolveFilePreviewKind, type FilePreviewKind } from "../src/lib/filePreviewKind.js";
import { resolveFilesBufferKind } from "../src/files-workbench/filesEditorKind.js";
import { createCodeViewerSourceForWorkspaceFile } from "../src/workspace-file-tree/model.js";

function expectedBufferKind(kind: FilePreviewKind): "text" | "preview" {
  return kind === "text" ? "text" : "preview";
}

function expectedTreeSourceType(kind: FilePreviewKind): "file" | "image" | "media" {
  if (kind === "image") return "image";
  if (kind === "media") return "media";
  // PDF / PPTX / Office 在侧栏仍用通用 file source，由 PreviewPane 统一分流。
  return "file";
}

const IMAGE_PATHS = [
  "/work/assets/photo.png",
  "/work/assets/photo.jpg",
  "/work/assets/photo.jpeg",
  "/work/assets/animation.gif",
  "/work/assets/photo.webp",
  "/work/assets/photo.avif",
  "/work/assets/photo.apng",
  "/work/assets/photo.bmp",
  "/work/assets/favicon.ico",
  "/work/assets/PHOTO.PNG",
  "C:\\work\\assets\\photo.JPG",
] as const;

const MEDIA_PATHS = [
  "/work/media/clip.mp4",
  "/work/media/clip.mov",
  "/work/media/clip.webm",
  "/work/media/clip.m4v",
  "/work/media/voice.mp3",
  "/work/media/voice.wav",
  "/work/media/voice.m4a",
  "/work/media/voice.ogg",
  "/work/media/voice.opus",
  "/work/media/voice.flac",
  "/work/media/voice.weba",
  "C:\\work\\media\\CLIP.MP4",
] as const;

const PDF_PATHS = ["/work/docs/report.pdf", "/work/docs/REPORT.PDF", "C:\\work\\docs\\report.Pdf"];
const PPTX_PATHS = [
  "/work/decks/slides.pptx",
  "/work/decks/SLIDES.PPTX",
  "C:\\work\\decks\\slides.Pptx",
];
const OFFICE_PATHS = [
  "/work/docs/report.docx",
  "/work/docs/report.doc",
  "/work/docs/sheet.xlsx",
  "/work/docs/sheet.xlsm",
  "/work/docs/sheet.xls",
  "C:\\work\\docs\\SHEET.XLSX",
];
const TEXT_PATHS = [
  "/work/README",
  "/work/LICENSE",
  "/work/Makefile",
  "/work/notes.txt",
  "/work/archive.unknownext",
  "/work/src/component.tsx",
  "/work/src/index.ts",
  "/work/src/index.js",
  "/work/src/data.json",
  "/work/scripts/run.py",
  "/work/docs/guide.md",
  "/work/docs/guide.markdown",
  "/work/assets/vector.svg",
  "/work/assets/VECTOR.SVG",
  "C:\\work\\README",
  "C:\\work\\docs\\GUIDE.MD",
  "C:\\work\\assets\\vector.Svg",
];

const CLASSIFICATION_CASES: readonly (readonly [string, FilePreviewKind])[] = [
  ...IMAGE_PATHS.map((path) => [path, "image"] as const),
  ...MEDIA_PATHS.map((path) => [path, "media"] as const),
  ...PDF_PATHS.map((path) => [path, "pdf"] as const),
  ...PPTX_PATHS.map((path) => [path, "pptx"] as const),
  ...OFFICE_PATHS.map((path) => [path, "office"] as const),
  ...TEXT_PATHS.map((path) => [path, "text"] as const),
];

test("共用路径分类覆盖图片、媒体、PDF、PPTX、Office 与文本候选", () => {
  for (const [path, expectedKind] of CLASSIFICATION_CASES) {
    assert.equal(resolveFilePreviewKind(path), expectedKind, path);
  }
});

test("SVG 仍是文本，不进入图片只读预览", () => {
  assert.equal(resolveFilePreviewKind("/work/assets/vector.svg"), "text");
  assert.equal(resolveFilePreviewKind("C:\\work\\assets\\VECTOR.SVG"), "text");
  assert.equal(resolveFilesBufferKind("/work/assets/vector.svg"), "text");
  assert.equal(createCodeViewerSourceForWorkspaceFile("/work/assets/vector.svg").type, "file");
});

test("未知扩展名与无扩展名只作为文本候选", () => {
  for (const path of [
    "/work/archive.unknownext",
    "/work/README",
    "/work/LICENSE",
    "/work/Makefile",
  ]) {
    assert.equal(resolveFilePreviewKind(path), "text", path);
    assert.equal(resolveFilesBufferKind(path), "text", path);
  }
});

test("缺失或空白路径按文本候选处理", () => {
  assert.equal(resolveFilePreviewKind(), "text");
  assert.equal(resolveFilePreviewKind(""), "text");
  assert.equal(resolveFilePreviewKind("   "), "text");
});

test("文件工作台缓冲类型和侧栏 source 类型与共用分类一致", () => {
  for (const [path, expectedKind] of CLASSIFICATION_CASES) {
    assert.equal(
      resolveFilesBufferKind(path),
      expectedBufferKind(expectedKind),
      `buffer kind: ${path}`,
    );
    assert.equal(
      createCodeViewerSourceForWorkspaceFile(path).type,
      expectedTreeSourceType(expectedKind),
      `tree source: ${path}`,
    );
  }
});

test("pptx 不被 Office 分类抢走", () => {
  assert.equal(resolveFilePreviewKind("/work/decks/slides.pptx"), "pptx");
  assert.notEqual(resolveFilePreviewKind("/work/decks/slides.pptx"), "office");
});

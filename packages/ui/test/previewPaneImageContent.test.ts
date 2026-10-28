import assert from "node:assert/strict";
import test from "node:test";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { PreviewPaneContent } from "../src/previewPaneContent.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "../src/lib/codePreviewSettings.js";

type PreviewPaneContentProps = ComponentProps<typeof PreviewPaneContent>;

const imageSource = {
  type: "image" as const,
  title: "screenshot.png",
  path: "/workspace/screenshot.png",
  mediaType: "image/png",
};

const baseProps: PreviewPaneContentProps = {
  source: imageSource,
  filePreview: null,
  fileTooLarge: false,
  loadingInitial: false,
  loadingImagePreview: false,
  imagePreviewUrl: "blob:preview-object-url",
  mediaSource: null,
  loadingMediaPreview: false,
  mediaPreviewUrl: null,
  onMediaError: () => undefined,
  onMediaLoadedMetadata: () => undefined,
  loadingPdfPreview: false,
  pdfViewerSource: null,
  pdfViewerLabels: {
    loading: "loading",
    loadError: "load error",
    noData: "no data",
    previousPage: "previous",
    nextPage: "next",
    pageInput: "page",
    zoomIn: "zoom in",
    zoomOut: "zoom out",
  },
  loadingOfficePreview: false,
  officePreview: null,
  officePreviewKind: null,
  loadingPptxPreview: false,
  pptxPreviewData: null,
  pptxViewerLabels: {
    loading: "loading",
    loadError: "load error",
    noSlides: "no slides",
    previousPage: "previous",
    nextPage: "next",
    pageInput: "page",
    zoomIn: "zoom in",
    zoomOut: "zoom out",
    thumbnails: "thumbnails",
    thumbnail: (pageNumber) => `thumbnail ${pageNumber}`,
    exportPdf: "export",
    exportingPdf: "exporting",
    exportPdfSuccess: () => "exported",
    exportPdfFailed: "export failed",
    selectElement: "select",
    exitElementSelection: "exit",
    aiEdit: "ai edit",
    commentPlaceholder: "comment",
    cancelAiEdit: "cancel",
    addToConversation: "add",
    referencedPageMissing: (pageNumber) => `missing ${pageNumber}`,
    referencedSourceChanged: (pageNumber) => `changed ${pageNumber}`,
  },
  pptxReferenceSource: null,
  pptxReferenceNavigation: null,
  pptxReferenceNavigationReady: false,
  error: null,
  codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
  codeTheme: "github-dark",
  resolvedTheme: "dark",
  theme: "dark",
  markdownViewMode: "preview",
  svgViewMode: "preview",
  wrapLongLines: false,
  codeComments: [],
  codeCommentLabels: {
    addComment: "add",
    addCommentTooltip: "add tooltip",
    commentPlaceholder: "placeholder",
    submitComment: "submit",
    cancelComment: "cancel",
    deleteComment: "delete",
    commentLine: "line",
    commentRange: "range",
  },
};

function render(overrides: Partial<PreviewPaneContentProps> = {}): string {
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN",
      children: createElement(PreviewPaneContent, { ...baseProps, ...overrides }),
    }),
  );
}

test("图片成功分支把 blob URL 原样交给 ImagePreviewContent", () => {
  const markup = render();

  assert.match(markup, /src="blob:preview-object-url"/);
  assert.match(markup, /alt="screenshot.png"/);
  // 不再把整文件拼成 data:base64 塞进 img src。
  assert.doesNotMatch(markup, /data:image\/png;base64/);
});

test("图片加载分支只渲染 loading 文案，不渲染 img", () => {
  const markup = render({ loadingImagePreview: true, imagePreviewUrl: null });

  assert.match(markup, /正在加载图片预览/);
  assert.doesNotMatch(markup, /<img/);
});

test("图片错误分支展示本地化提示且不渲染 img", () => {
  const markup = render({
    error: "图片超过预览上限（64 MiB），请使用其他应用打开。",
    imagePreviewUrl: null,
  });

  assert.match(markup, /图片超过预览上限（64 MiB），请使用其他应用打开。/);
  assert.doesNotMatch(markup, /<img/);
});

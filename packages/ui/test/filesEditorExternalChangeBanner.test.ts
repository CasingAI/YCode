import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { FilesEditorExternalChangeBanner } from "../src/files-workbench/FilesEditorExternalChangeBanner.js";
import {
  createPreviewBuffer,
  createTextFileBuffer,
} from "../src/files-workbench/filesEditorModel.js";

const workspace = { workspacePath: "/work" };

function render(buffer: Parameters<typeof FilesEditorExternalChangeBanner>[0]["buffer"]) {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(FilesEditorExternalChangeBanner, {
        buffer,
        onReload: () => undefined,
        onKeep: () => undefined,
      }),
    ),
  );
}

test("外部变化提示条只读取 externalChange，不渲染空提示", () => {
  const buffer = createTextFileBuffer({ workspace, path: "/work/a.txt", text: "draft" });
  assert.equal(render(buffer), "");

  const changed = { ...buffer, externalChange: { kind: "changed" as const } };
  const html = render(changed);
  assert.match(html, /data-files-external-change="changed"/);
});

test("删除提示不提供 Reload，避免把已删除文件当普通修改重载", () => {
  const buffer = {
    ...createTextFileBuffer({ workspace, path: "/work/a.txt", text: "draft" }),
    externalChange: { kind: "deleted" as const, observedVersion: null },
  };
  const html = render(buffer);
  assert.match(html, /data-files-external-change="deleted"/);
  assert.doesNotMatch(html, /filesWorkbench\.externalChange\.reload/);
  assert.doesNotMatch(html, />Reload</);
  assert.match(html, />Keep draft</);
});

test("外部变化提示使用语义 warning token 与 text-ui 字号", () => {
  const html = render({
    ...createTextFileBuffer({ workspace, path: "/work/a.txt", text: "draft" }),
    externalChange: { kind: "changed" as const },
  });
  assert.match(html, /border-warning\/40/);
  assert.match(html, /bg-warning\/10/);
  assert.match(html, /text-ui-sm/);
  assert.doesNotMatch(html, /text-xs|amber-/);
});

test("预览缓冲永远不显示文本外部变化提示", () => {
  const preview = {
    ...createPreviewBuffer({ workspace, path: "/work/image.png" }),
    externalChange: { kind: "changed" as const },
  };
  assert.equal(render(preview), "");
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { FilesLargeTextDraftStatusView } from "../src/files-workbench/FilesLargeTextDraftStatus.js";
import type { FilesLargeTextDraftStatusEntry } from "../src/files-workbench/FilesLargeTextDraftStatus.js";

/**
 * 大文件 IndexedDB 草稿状态提示只做投影展示：
 * - pending / blocked / error 必须可见，blocked 不能静默删除；
 * - retry 显式触发，discard 必须二次确认。
 */

const statusSource = readFileSync(
  new URL("../src/files-workbench/FilesLargeTextDraftStatus.tsx", import.meta.url),
  "utf8",
);

function render(entries: readonly FilesLargeTextDraftStatusEntry[]): string {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(FilesLargeTextDraftStatusView, {
        entries,
        onRetry: () => undefined,
        onDiscard: () => undefined,
      }),
    ),
  );
}

test("没有草稿状态时不渲染任何提示", () => {
  assert.equal(render([]), "");
});

test("pending 草稿显示文件名与去抖写入状态", () => {
  const html = render([{ bufferId: "b1", name: "huge.log", status: "pending" }]);
  assert.match(html, /data-files-large-text-draft-status=""/);
  assert.match(html, /data-files-large-text-draft-pending=""/);
  assert.match(html, /正在保存大文件草稿：huge\.log/);
  assert.doesNotMatch(html, /data-files-large-text-draft-blocked=""/);
});

test("blocked 草稿显示原因、重试与放弃入口，且放弃不直接删除", () => {
  const html = render([
    {
      bufferId: "b1",
      name: "huge.log",
      status: "blocked",
      blockedReason: "version-mismatch",
    },
  ]);
  assert.match(html, /data-files-large-text-draft-blocked=""/);
  assert.match(html, /文件版本已变化，huge\.log 的草稿基于旧版本，无法套用。/);
  assert.match(html, />重试</);
  assert.match(html, />放弃草稿</);
  // 二次确认弹窗默认关闭，不能渲染删除动作。
  assert.doesNotMatch(html, /data-files-large-text-draft-discard-dialog=""/);
  assert.doesNotMatch(html, />放弃并删除</);
});

test("error 草稿显示存储失败原因与重试，但不提供直接删除", () => {
  const html = render([{ bufferId: "b1", name: "huge.log", status: "error", errorKind: "quota" }]);
  assert.match(html, /data-files-large-text-draft-error=""/);
  assert.match(html, /存储空间不足，huge\.log 的草稿未保存。/);
  assert.match(html, />重试</);
  assert.doesNotMatch(html, />放弃草稿</);
});

test("放弃按钮只打开确认弹窗，确认后才调用 onDiscard 并标记破坏性操作", () => {
  const discardButton = statusSource.match(/onClick=\{\(\) => setConfirmingDiscard\(entry\)\}/);
  assert.ok(discardButton, "「放弃草稿」只能打开确认弹窗，不能直接删除");

  assert.match(
    statusSource,
    /const confirmDiscard = useCallback\(\(\) => \{[\s\S]*?onDiscard\(confirmingDiscard\.bufferId\);[\s\S]*?\}, \[confirmingDiscard, onDiscard\]\);/,
    "onDiscard 只能在确认回调中调用",
  );
  assert.match(
    statusSource,
    /<Button type="button" variant="destructive" onClick=\{confirmDiscard\}>/,
    "确认删除必须使用 destructive 语义",
  );
  assert.match(statusSource, /filesWorkbench\.largeTextDraft\.discardConfirm/);
});

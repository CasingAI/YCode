import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { ModelDeletionFeedbackView } from "../src/settings/model-provider-section/ModelDeletionFeedbackView.js";
import {
  createModelDeletionFeedbackController,
  type ModelDeletionFeedbackEntry,
} from "../src/settings/model-provider-section/modelDeletionFeedback.js";

function renderFeedback(entries: readonly ModelDeletionFeedbackEntry[], locale = "zh-CN") {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: locale as "zh-CN" | "en-US" },
      createElement(ModelDeletionFeedbackView, {
        entries,
        onRetry: () => undefined,
        onDismiss: () => undefined,
      }),
    ),
  );
}

test("连续删除 20 个模型只渲染一条汇总，不逐个输出成功模型", async () => {
  const controller = createModelDeletionFeedbackController();
  await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      controller.run({ providerId: "p", modelId: `model-${index}`, operation: async () => {} }),
    ),
  );
  const markup = renderFeedback(controller.getSnapshot());
  assert.equal(markup.match(/data-testid="model-deletion-feedback"/g)?.length, 1);
  assert.match(markup, /已删除 20 个模型/);
  assert.doesNotMatch(markup, /model-\d/);
  assert.doesNotMatch(markup, /<details/);
});

test("混合结果共享汇总，失败详情默认折叠且可滚动和换行", () => {
  const entries: ModelDeletionFeedbackEntry[] = [
    { key: "ok", providerId: "p", modelId: "ok", state: "success" },
    {
      key: "failed",
      providerId: "p",
      modelId: "vendor/very-long-model-name",
      state: "failure",
      error: "<error> permission denied",
    },
    { key: "waiting", providerId: "p", modelId: "waiting", state: "pending" },
  ];
  const markup = renderFeedback(entries);
  assert.equal(markup.match(/data-testid="model-deletion-feedback"/g)?.length, 1);
  assert.match(markup, /已删除 1 个模型/);
  assert.match(markup, /1 个失败/);
  assert.match(markup, /正在删除 1 个/);
  assert.match(markup, /<details[\s>]/);
  assert.doesNotMatch(markup, /<details[^>]*\sopen(?:=|\s|>)/);
  assert.match(markup, /overflow-y-auto/);
  assert.match(markup, /max-h-/);
  assert.match(markup, /\[overflow-wrap:anywhere\]/);
  assert.match(markup, /vendor\/very-long-model-name/);
  assert.match(markup, /&lt;error&gt; permission denied/);
  assert.match(markup, /重试/);
  assert.match(markup, /aria-label="关闭"[^>]*disabled=""/);
  assert.doesNotMatch(markup, />waiting</);
});

test("失败项重试后汇总归零失败，成功目标不会再次提交", async () => {
  const controller = createModelDeletionFeedbackController();
  let attempts = 0;
  const operation = async () => {
    if (++attempts === 1) throw new Error("controlled failure");
  };
  await assert.rejects(controller.run({ providerId: "p", modelId: "failed", operation }));
  assert.match(renderFeedback(controller.getSnapshot()), /1 个失败/);
  await controller.retry(controller.getSnapshot()[0]!.key);
  await controller.run({ providerId: "p", modelId: "failed", operation });
  const markup = renderFeedback(controller.getSnapshot());
  assert.match(markup, /已删除 1 个模型/);
  assert.doesNotMatch(markup, /个失败|controlled failure|<details/);
  assert.equal(attempts, 2);
});

test("英文汇总使用翻译资源；空快照不显示提示", () => {
  assert.equal(renderFeedback([]), "");
  const markup = renderFeedback(
    [{ key: "ok", providerId: "p", modelId: "ok", state: "success" }],
    "en-US",
  );
  assert.match(markup, /Deleted: 1/);
  assert.match(markup, /aria-label="Close"/);
});

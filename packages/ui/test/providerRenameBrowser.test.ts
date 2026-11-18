import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { loadChromium, resolveSource, uiRoot } from "./helpers/chromiumFixture.js";

const fixture = `
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { InlineEditableProviderCard } from "@/settings/model-provider-section/InlineEditableProviderCard.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";

const pending = [];
function Harness() {
  const [provider, setProvider] = useState({
    providerId: "account-test",
    providerName: "Codex Test",
    templateId: "cliproxy-codex",
    displayMode: "submenu",
    enabled: true,
    executable: true,
    hasPersonalConfig: true,
    personalConfig: {},
    config: { api: { type: "openai-responses" } },
    models: [{
      kind: "candidate",
      modelId: "codex-test/vendor/model",
      builtin: false,
      config: { displayName: "vendor/model" },
      personalConfig: {},
      hasPersonalConfig: false,
      executable: true,
      selectable: true,
    }],
  });
  const [testedModel, setTestedModel] = useState("");
  const [submitted, setSubmitted] = useState([]);
  return <>
    <button data-testid="outside">Outside</button>
    <button data-testid="publish" onClick={() => {
      const next = pending.shift();
      setProvider((current) => ({ ...current, providerName: next.name }));
      next.done();
    }}>Publish</button>
    <output data-testid="submitted">{JSON.stringify(submitted)}</output>
    <output data-testid="tested-model">{testedModel}</output>
    <InlineEditableProviderCard provider={provider} hideConnectionSection onTestModel={async (providerId, modelId) => {
      setTestedModel(providerId + ":" + modelId);
      return { success: true };
    }} onSave={(next) => {
      const name = next.providerNameUpdate;
      setSubmitted((current) => [...current, name]);
      return new Promise((done) => pending.push({ name, done }));
    }} />
  </>;
}
createRoot(document.getElementById("root")).render(
  <ZCodeIntlProvider initialLocale="zh-CN"><TooltipProvider><ServiceProvider services={{}}><PlatformProvider platform={{}}><Harness /></PlatformProvider></ServiceProvider></TooltipProvider></ZCodeIntlProvider>,
);
`;

test("CLI Proxy 既有菜单聚焦名称，支持确认、取消与延迟回显", { timeout: 45_000 }, async (t) => {
  const browser = await loadChromium();
  if (!browser) return t.skip("未找到独立 Chromium");
  const { build } = await import("esbuild");
  const directory = await mkdtemp(join(tmpdir(), "ycode-provider-rename-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { outputFiles } = await build({
    stdin: { contents: fixture, loader: "tsx", resolveDir: uiRoot },
    bundle: true,
    write: false,
    platform: "browser",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "silent",
    loader: { ".svg": "dataurl", ".png": "dataurl", ".mp3": "empty", ".wav": "empty" },
    plugins: [
      {
        name: "ui-source",
        setup(builder) {
          builder.onResolve({ filter: /^@\// }, async (args) => {
            const path = await resolveSource(resolve(uiRoot, "src", args.path.slice(2)));
            return path ? { path } : undefined;
          });
        },
      },
    ],
  });
  const context = await browser.chromium.launchPersistentContext(join(directory, "profile"), {
    executablePath: browser.executablePath,
    headless: true,
  });
  try {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setContent('<main id="root"></main>');
    await page.addScriptTag({
      content: `globalThis.__name = value => value;\n${outputFiles[0]!.text}`,
    });
    assert.deepEqual(errors, []);
    const header = page.getByTestId("model-provider-header");
    const input = page.getByTestId("model-provider-name-input");
    const publish = page.getByTestId("publish");
    const waitForSubmitted = (values: string[]) =>
      page
        .getByTestId("submitted")
        .getByText(JSON.stringify(values), { exact: true })
        .waitFor({ timeout: 3000 });
    const startRename = async () => {
      await page
        .getByTestId("model-provider-actions-button")
        .click({ timeout: 5000 })
        .catch((error) => {
          assert.deepEqual(errors, []);
          throw error;
        });
      await page.getByTestId("model-provider-name-edit-button").click();
      await page
        .locator('[data-testid="model-provider-name-input"]:focus')
        .waitFor({ timeout: 3000 });
    };

    await page.getByText("vendor/model", { exact: true }).waitFor({ timeout: 5000 });
    await page.getByTitle("测试模型", { exact: true }).click();
    await page
      .getByTestId("tested-model")
      .getByText("account-test:codex-test/vendor/model", { exact: true })
      .waitFor();

    await startRename();
    await input.fill("  Codex Work  ");
    await input.press("Enter");
    await waitForSubmitted(["Codex Work"]);
    await publish.click();
    await header.getByText("Codex Work", { exact: true }).waitFor();
    await startRename();
    assert.equal(await input.inputValue(), "Codex Work");
    await input.fill("Cancelled");
    await input.press("Escape");
    await waitForSubmitted(["Codex Work"]);

    await startRename();
    await input.fill("Codex Other");
    await page.getByTestId("outside").click();
    await waitForSubmitted(["Codex Work", "Codex Other"]);
    await startRename();
    await input.fill("Codex Work");
    await input.press("Enter");
    await waitForSubmitted(["Codex Work", "Codex Other", "Codex Work"]);
    await publish.click();
    await header.getByText("Codex Other", { exact: true }).waitFor();
    await publish.click();
    await header.getByText("Codex Work", { exact: true }).waitFor();
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

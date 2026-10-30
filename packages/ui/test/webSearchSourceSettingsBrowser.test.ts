import assert from "node:assert/strict";
import test from "node:test";
import { loadChromium } from "./helpers/chromiumFixture.js";
import { createWebSearchSourceFixture, makeProvider } from "./helpers/webSearchSourceFixture.js";

// 独立 Chromium 执行已有实例的编辑/删除、总开关关闭态与空目录入口
// （docs/specs/web-search-provider-capability.md 验收场景 3 / 8 / 10b）。
// 只启动本测试自己的无头浏览器，不连接也不操作正在运行的 YCode。

const jinaProvider = (overrides: Partial<Parameters<typeof makeProvider>[0]> = {}) =>
  makeProvider({
    providerId: "jina-1",
    providerName: "Jina",
    templateId: "jina",
    apiKey: "old-key",
    baseUrl: "https://s.jina.ai",
    ...overrides,
  });

test("独立浏览器执行搜索源设置与总开关交互", { timeout: 180_000 }, async (t) => {
  const loaded = await loadChromium();
  if (!loaded) {
    t.skip("未找到独立 Chromium；可设置 ZCODE_TEST_CHROMIUM_PATH 后重跑搜索源交互测试");
    return;
  }
  const fixture = await createWebSearchSourceFixture();
  const browser = await loaded.chromium.launch({
    executablePath: loaded.executablePath,
    headless: true,
  });
  try {
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await t.test("已有实例可清空 Key、改代理并在确认后删除", async () => {
      await fixture.mount(page, { providers: [jinaProvider()] });
      await page.getByTestId("settings.webSearch.openSettings.jina-1").click();
      await page.getByTestId("settings.webSearch.sourceDialog").waitFor();
      const keyInput = page.getByTestId("settings.webSearch.sourceApiKeyInput");
      assert.equal(await keyInput.inputValue(), "old-key");
      await keyInput.fill("");
      await page.getByTestId("settings.webSearch.sourceProxyTrigger").click();
      await page.getByTestId("settings.webSearch.sourceProxyItem.proxy").click();
      await page.getByTestId("settings.webSearch.sourceSave").click();
      await page.getByTestId("settings.webSearch.sourceDialog").waitFor({ state: "detached" });
      let state = await fixture.readProbe(page);
      assert.deepEqual(state.saveCalls[0].personalConfig.access, { type: "api-key" });
      assert.equal(state.saveCalls[0].proxyModeUpdate, "proxy");

      await page.getByTestId("settings.webSearch.openSettings.jina-1").click();
      await page.getByTestId("settings.webSearch.sourceDialog").waitFor();
      assert.equal(await keyInput.inputValue(), "", "清空后的权威 Key 为空");
      await keyInput.fill("new-key");
      await page.getByTestId("settings.webSearch.sourceProxyTrigger").click();
      await page.getByTestId("settings.webSearch.sourceProxyItem.direct").click();
      await page.getByTestId("settings.webSearch.sourceSave").click();
      await page.getByTestId("settings.webSearch.sourceDialog").waitFor({ state: "detached" });
      state = await fixture.readProbe(page);
      assert.deepEqual(state.saveCalls[1].personalConfig.access, {
        type: "api-key",
        apiKey: "new-key",
      });
      assert.equal(state.saveCalls[1].proxyModeUpdate, "direct");

      await page.getByTestId("settings.webSearch.openSettings.jina-1").click();
      await page.getByTestId("settings.webSearch.sourceDialog").waitFor();
      await page.evaluate(() => {
        (globalThis as any).__ws.confirmResult = false;
      });
      await page.getByTestId("settings.webSearch.sourceDelete").click();
      await page.waitForTimeout(50);
      assert.equal((await fixture.readProbe(page)).deleteCalls.length, 0, "取消确认不得删除");
      await page.getByTestId("settings.webSearch.sourceDialog").waitFor();

      await page.evaluate(() => {
        (globalThis as any).__ws.confirmResult = true;
      });
      await page.getByTestId("settings.webSearch.sourceDelete").click();
      await page.getByTestId("settings.webSearch.sourceDialog").waitFor({ state: "detached" });
      state = await fixture.readProbe(page);
      assert.deepEqual(state.deleteCalls, ["jina-1"]);
      assert.equal(state.rowCount, 0);
    });

    await t.test("总开关关闭时仍可配置/删除实例，但排序控件禁用", async () => {
      await fixture.mount(page, {
        enabled: false,
        providers: [
          jinaProvider(),
          jinaProvider({ providerId: "jina-2", providerName: "Jina-2", apiKey: "second-key" }),
        ],
      });
      let state = await fixture.readProbe(page);
      assert.equal(state.settingsButtons, 2, "关闭总开关不隐藏实例设置入口");
      assert.equal(
        await page.getByTestId("settings.webSearch.moveDown.jina-1").isDisabled(),
        true,
        "关闭时禁用上下移动",
      );
      assert.equal(
        await page.getByTestId("settings.webSearch.moveUp.jina-2").isDisabled(),
        true,
        "关闭时禁用上下移动",
      );
      assert.equal(
        await page.locator('[data-web-search-drag-handle="jina-2"]').isDisabled(),
        true,
        "关闭时禁用拖拽手柄",
      );

      await page.getByTestId("settings.webSearch.openSettings.jina-1").click();
      await page.getByTestId("settings.webSearch.sourceDialog").waitFor();
      await page.getByTestId("settings.webSearch.sourceApiKeyInput").fill("off-key");
      await page.getByTestId("settings.webSearch.sourceSave").click();
      await page.getByTestId("settings.webSearch.sourceDialog").waitFor({ state: "detached" });
      state = await fixture.readProbe(page);
      assert.equal(state.saveCalls.length, 1, "关闭总开关仍可保存实例配置");
      assert.deepEqual(state.updateCalls, [], "关闭时不得写入搜索源顺序");

      await page.getByTestId("settings.webSearch.openSettings.jina-1").click();
      await page.getByTestId("settings.webSearch.sourceDialog").waitFor();
      await page.evaluate(() => {
        (globalThis as any).__ws.confirmResult = true;
      });
      await page.getByTestId("settings.webSearch.sourceDelete").click();
      await page.getByTestId("settings.webSearch.sourceDialog").waitFor({ state: "detached" });
      assert.deepEqual((await fixture.readProbe(page)).deleteCalls, ["jina-1"], "关闭时仍可删除");
    });

    await t.test("模板目录为空或加载中时禁用添加，不打开无解空表单", async () => {
      await fixture.mount(page, { providers: [jinaProvider()], templates: [] });
      const addSource = page.getByTestId("settings.webSearch.addSource");
      assert.equal(await addSource.isDisabled(), true, "目录为空时禁用添加");
      await page.evaluate(() => {
        document
          .querySelector<HTMLButtonElement>('[data-testid="settings.webSearch.addSource"]')
          ?.click();
      });
      await page.waitForTimeout(50);
      assert.equal(await page.getByTestId("settings.webSearch.sourceDialog").count(), 0);

      await fixture.mount(page, { providers: [jinaProvider()], loading: true });
      assert.equal(
        await page.getByTestId("settings.webSearch.addSource").isDisabled(),
        true,
        "模板仍在加载时禁用添加",
      );
    });

    assert.deepEqual(pageErrors, [], "页面不应出现未捕获错误");
  } finally {
    await browser.close();
    await fixture.cleanup();
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { loadChromium } from "./helpers/chromiumFixture.js";
import { createWebSearchSourceFixture, makeProvider } from "./helpers/webSearchSourceFixture.js";

// 独立 Chromium 中执行真实的 WebSearchSettingsSection + WebSearchSourceDialog
// （docs/specs/web-search-provider-capability.md「独立搜索源实例的添加 / 编辑 / 删除」）。
// 只替换 Host/Service 边界，模板目录、候选识别、表单与弹窗交互全部走生产源码，
// 且只启动本测试自己的无头浏览器，不连接也不操作正在运行的 YCode。

const jinaProvider = (overrides: Partial<Parameters<typeof makeProvider>[0]> = {}) =>
  makeProvider({
    providerId: "jina-1",
    providerName: "Jina",
    templateId: "jina",
    apiKey: "old-key",
    baseUrl: "https://s.jina.ai",
    ...overrides,
  });

test("独立浏览器执行搜索源添加与草稿交互", { timeout: 180_000 }, async (t) => {
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

    await t.test(
      "添加入口只打开弹窗；单模板目录只展示 Jina；四家聊天搜索源无设置入口",
      async () => {
        await fixture.mount(page, {
          providers: [
            jinaProvider(),
            ...["zai-api", "bigmodel-api", "minimax-token-plan", "deepseek"].map(
              (templateId, index) =>
                makeProvider({
                  providerId: `chat-${index}`,
                  providerName: templateId,
                  templateId,
                  apiKey: "plan-key",
                }),
            ),
          ],
        });
        let state = await fixture.readProbe(page);
        assert.equal(state.rowCount, 5);
        assert.equal(state.settingsButtons, 1, "只有可手动添加的 Jina 实例有设置入口");

        await page.getByTestId("settings.webSearch.addSource").click();
        await page.getByTestId("settings.webSearch.sourceDialog").waitFor();
        assert.equal(
          await page.getByTestId("settings.webSearch.sourceTemplateValue").innerText(),
          "Jina Search API",
        );
        assert.equal(
          await page.getByTestId("settings.webSearch.sourceTemplateTrigger").count(),
          0,
          "唯一模板不渲染单选控件",
        );
        state = await fixture.readProbe(page);
        assert.deepEqual(state.createCalls, [], "打开弹窗不得落盘");

        await page.getByRole("button", { name: "Cancel" }).click();
        await page.getByTestId("settings.webSearch.sourceDialog").waitFor({ state: "detached" });
        state = await fixture.readProbe(page);
        assert.deepEqual(state.createCalls, [], "取消不得落盘");
      },
    );

    await t.test("填写 Key 提交才创建；提交中禁用且不可关闭", async () => {
      await fixture.mount(page, { providers: [jinaProvider()] });
      await page.evaluate(() => {
        (globalThis as any).__ws.createMode = "deferred";
      });
      await page.getByTestId("settings.webSearch.addSource").click();
      await page.getByTestId("settings.webSearch.sourceDialog").waitFor();
      const save = page.getByTestId("settings.webSearch.sourceSave");
      assert.equal(await save.isDisabled(), true, "Key 为空时不可提交");
      await page.getByTestId("settings.webSearch.sourceApiKeyInput").fill("jina-key");
      assert.equal(await save.isDisabled(), false);

      await save.click();
      await page.waitForFunction(() => (globalThis as any).__ws.createCalls.length === 1);
      assert.equal(await save.isDisabled(), true, "提交期间禁用按钮");
      await page.evaluate(() => {
        document
          .querySelector<HTMLButtonElement>('[data-testid="settings.webSearch.sourceSave"]')
          ?.click();
      });
      await page.keyboard.press("Escape");
      await page.getByTestId("settings.webSearch.sourceDialog").waitFor();
      let state = await fixture.readProbe(page);
      assert.equal(state.createCalls.length, 1, "重复点击与关闭不得产生第二个实例");
      assert.deepEqual(state.createCalls[0], {
        templateId: "jina",
        initialConfig: { access: { type: "api-key", apiKey: "jina-key" } },
      });

      await page.evaluate(() => (globalThis as any).__ws.resolveCreate());
      await page.getByTestId("settings.webSearch.sourceDialog").waitFor({ state: "detached" });
      state = await fixture.readProbe(page);
      assert.equal(state.rowCount, 2, "创建成功后候选出现");
    });

    await t.test("provider 列表以新对象刷新后，创建与编辑草稿都不丢", async () => {
      // 创建态：填 Key/代理后刷新列表，草稿必须保留并随提交落盘。
      await fixture.mount(page, { providers: [jinaProvider()] });
      await page.getByTestId("settings.webSearch.addSource").click();
      await page.getByTestId("settings.webSearch.sourceDialog").waitFor();
      const keyInput = page.getByTestId("settings.webSearch.sourceApiKeyInput");
      await keyInput.fill("draft-key");
      await page.getByTestId("settings.webSearch.sourceProxyTrigger").click();
      await page.getByTestId("settings.webSearch.sourceProxyItem.proxy").click();
      await page.evaluate(() => (globalThis as any).__ws.refreshProviders());
      assert.equal(await keyInput.inputValue(), "draft-key", "刷新列表不得重置已输入 Key");
      assert.match(
        await page.getByTestId("settings.webSearch.sourceProxyTrigger").innerText(),
        /Use proxy/,
        "刷新列表不得重置已选代理",
      );
      assert.equal(
        await page.getByTestId("settings.webSearch.sourceTemplateValue").innerText(),
        "Jina Search API",
        "刷新列表不得重置模板展示",
      );
      await page.getByTestId("settings.webSearch.sourceSave").click();
      await page.getByTestId("settings.webSearch.sourceDialog").waitFor({ state: "detached" });
      let state = await fixture.readProbe(page);
      assert.equal(state.createCalls.length, 1);
      assert.equal((state.createCalls[0].initialConfig as any).access.apiKey, "draft-key");
      assert.equal(state.saveCalls[0].proxyModeUpdate, "proxy");

      // 编辑态：刷新 provider 对象引用后，Key 与代理同样保留。
      await fixture.mount(page, { providers: [jinaProvider()] });
      await page.getByTestId("settings.webSearch.openSettings.jina-1").click();
      await page.getByTestId("settings.webSearch.sourceDialog").waitFor();
      await keyInput.fill("edited-draft");
      await page.getByTestId("settings.webSearch.sourceProxyTrigger").click();
      await page.getByTestId("settings.webSearch.sourceProxyItem.direct").click();
      await page.evaluate(() => (globalThis as any).__ws.refreshProviders());
      assert.equal(await keyInput.inputValue(), "edited-draft", "编辑草稿不得被刷新重置");
      assert.match(
        await page.getByTestId("settings.webSearch.sourceProxyTrigger").innerText(),
        /Direct connection/,
      );
      await page.getByTestId("settings.webSearch.sourceSave").click();
      await page.getByTestId("settings.webSearch.sourceDialog").waitFor({ state: "detached" });
      state = await fixture.readProbe(page);
      assert.equal(state.saveCalls.length, 1);
      assert.equal(state.saveCalls[0].personalConfig.access.apiKey, "edited-draft");
      assert.equal(state.saveCalls[0].proxyModeUpdate, "direct");
    });

    await t.test("创建成功但代理写入失败时转编辑态，保留 Key 且重试只补代理", async () => {
      await fixture.mount(page, { providers: [jinaProvider()] });
      await page.evaluate(() => {
        (globalThis as any).__ws.saveMode = "failOnce";
      });
      await page.getByTestId("settings.webSearch.addSource").click();
      await page.getByTestId("settings.webSearch.sourceDialog").waitFor();
      const keyInput = page.getByTestId("settings.webSearch.sourceApiKeyInput");
      await keyInput.fill("proxy-key");
      await page.getByTestId("settings.webSearch.sourceProxyTrigger").click();
      await page.getByTestId("settings.webSearch.sourceProxyItem.proxy").click();
      await page.getByTestId("settings.webSearch.sourceSave").click();
      await page.getByRole("alert").waitFor();

      let state = await fixture.readProbe(page);
      assert.equal(state.createCalls.length, 1);
      assert.equal(state.saveCalls.length, 1);
      assert.equal(state.rowCount, 2, "实例已创建，不因代理失败回滚");
      assert.equal(await keyInput.inputValue(), "proxy-key", "转编辑态后 Key 不丢失");
      assert.match(await page.getByTestId("settings.webSearch.sourceDialog").innerText(), /Jina-2/);

      await page.getByTestId("settings.webSearch.sourceSave").click();
      await page.getByTestId("settings.webSearch.sourceDialog").waitFor({ state: "detached" });
      state = await fixture.readProbe(page);
      assert.equal(state.createCalls.length, 1, "重试不得重复创建");
      assert.equal(state.saveCalls.length, 2);
      assert.equal(state.saveCalls[1].proxyModeUpdate, "proxy");
    });

    await t.test("编辑实例被远端删除后弹窗自动关闭，不保留失效的保存/删除", async () => {
      await fixture.mount(page, { providers: [jinaProvider()] });
      await page.getByTestId("settings.webSearch.openSettings.jina-1").click();
      await page.getByTestId("settings.webSearch.sourceDialog").waitFor();
      await page.getByTestId("settings.webSearch.sourceApiKeyInput").fill("will-be-lost");
      await page.evaluate(() => (globalThis as any).__ws.removeProvider("jina-1"));
      await page.getByTestId("settings.webSearch.sourceDialog").waitFor({ state: "detached" });
      const state = await fixture.readProbe(page);
      assert.equal(state.rowCount, 0);
      assert.deepEqual(state.saveCalls, [], "失效实例不得保存");
      assert.deepEqual(state.deleteCalls, [], "失效实例不得删除");
      await page.getByTestId("settings.webSearch.empty").waitFor();
    });

    await t.test("目录将来有两个独立模板时，切换模板不弹回且草稿按模板重置", async () => {
      // 直接给弹窗传两份模板，模拟独立模板目录扩展（spec 验收 10c）。
      // 第二个 id 只是弹窗 props 的占位；生产目录仍由 shared 的
      // source === "independent" 决定（当前仅 jina），这里不会让四家进入添加目录。
      await fixture.mountDialog(page, {
        templates: [
          {
            templateId: "jina",
            label: "Jina Search API",
            accessType: "api-key",
            apiKeyManagementUrl: "https://jina.ai/api-keys",
          },
          { templateId: "zai-api", label: "Second search API", accessType: "api-key" },
        ],
      });
      const templateTrigger = page.getByTestId("settings.webSearch.sourceTemplateTrigger");
      const keyInput = page.getByTestId("settings.webSearch.sourceApiKeyInput");
      const proxyTrigger = page.getByTestId("settings.webSearch.sourceProxyTrigger");
      assert.match(await templateTrigger.innerText(), /Jina Search API/, "首次打开取目录首项");

      await keyInput.fill("first-key");
      await proxyTrigger.click();
      await page.getByTestId("settings.webSearch.sourceProxyItem.proxy").click();
      await templateTrigger.click();
      await page.getByTestId("settings.webSearch.sourceTemplateItem.zai-api").click();

      assert.match(
        await templateTrigger.innerText(),
        /Second search API/,
        "选择第二个模板后不得被重置弹回首项",
      );
      assert.equal(await keyInput.inputValue(), "", "切换模板清空上一个模板的 Key");
      assert.match(
        await proxyTrigger.innerText(),
        /Follow network settings/,
        "切换模板把代理恢复为默认",
      );

      await keyInput.fill("second-key");
      await page.getByTestId("settings.webSearch.sourceSave").click();
      await page.getByTestId("settings.webSearch.sourceDialog").waitFor({ state: "detached" });
      let state = await fixture.readProbe(page);
      assert.deepEqual(state.dialogCreateCalls, [
        {
          templateId: "zai-api",
          accessType: "api-key",
          apiKey: "second-key",
          proxyMode: "default",
        },
      ]);

      await page.evaluate(() => (globalThis as any).__ws.openDialog());
      await page.getByTestId("settings.webSearch.sourceDialog").waitFor();
      assert.match(await templateTrigger.innerText(), /Jina Search API/, "重开回到目录首项");
      assert.equal(await keyInput.inputValue(), "", "重开不保留上次 Key");
      assert.match(await proxyTrigger.innerText(), /Follow network settings/);

      await page.getByRole("button", { name: "Cancel" }).click();
      await page.getByTestId("settings.webSearch.sourceDialog").waitFor({ state: "detached" });
      state = await fixture.readProbe(page);
      assert.deepEqual(state.dialogCreateCalls.length, 1, "取消不得创建");
    });

    assert.deepEqual(pageErrors, [], "页面不应出现未捕获错误");
  } finally {
    await browser.close();
    await fixture.cleanup();
  }
});

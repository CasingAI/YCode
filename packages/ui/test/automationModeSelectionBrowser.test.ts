import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { loadChromium, resolveSource, uiRoot } from "./helpers/chromiumFixture.js";

const sourcePath = (name: string) => JSON.stringify(join(uiRoot, "src", name).replace(/\\/g, "/"));

function fixtureSource(): string {
  return `
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AutomationModeSelect } from ${sourcePath("settings/AutomationModeSelect.tsx")};
import {
  resolveAutomationModeValue,
  shouldSubmitAutomationMode,
} from ${sourcePath("settings/automationAgentConfigOptions.ts")};
import { ZCodeIntlProvider } from ${sourcePath("i18n/IntlProvider.tsx")};
import { TooltipProvider } from ${sourcePath("components/ui/tooltip.tsx")};

const SCENARIOS = {
  create: null,
  "edit-team": "team",
  "edit-legacy": null,
};

function Field({ testId, value, onValueChange }) {
  return <div data-testid={testId} className="@container/composer w-[520px]">
    <AutomationModeSelect value={value} onValueChange={onValueChange} />
  </div>;
}

function Fixture() {
  const [scenario, setScenario] = useState("create");
  const [scheduled, setScheduled] = useState("yolo");
  const [offPeak, setOffPeak] = useState("yolo");
  const [scheduledTouched, setScheduledTouched] = useState(false);
  const [offPeakTouched, setOffPeakTouched] = useState(false);
  const [payload, setPayload] = useState("");
  const applyScenario = (next) => {
    const archivedMode = SCENARIOS[next];
    const fallback = resolveAutomationModeValue(archivedMode);
    setScenario(next);
    setScheduled(fallback);
    setOffPeak(fallback);
    setScheduledTouched(false);
    setOffPeakTouched(false);
    setPayload("");
  };
  const submit = () => {
    const isEditing = scenario !== "create";
    setPayload(JSON.stringify({
      ...(shouldSubmitAutomationMode({ isEditing, touched: scheduledTouched })
        ? { mode: scheduled }
        : {}),
      ...(shouldSubmitAutomationMode({ isEditing, touched: offPeakTouched })
        ? { permissionMode: offPeak }
        : {}),
    }));
  };
  return <ZCodeIntlProvider initialLocale="zh-CN"><TooltipProvider>
    <main className="flex flex-col gap-4 p-4">
      <button data-testid="scenario-create" onClick={() => applyScenario("create")}>Create</button>
      <button data-testid="scenario-edit-team" onClick={() => applyScenario("edit-team")}>Edit team</button>
      <button data-testid="scenario-edit-legacy" onClick={() => applyScenario("edit-legacy")}>Edit legacy</button>
      <span>定时 / 周期 / 延时表单</span>
      <Field testId="scheduled-field" value={scheduled} onValueChange={(value) => {
        setScheduledTouched(true);
        setScheduled(value);
      }} />
      <span>闲时任务表单</span>
      <Field testId="offpeak-field" value={offPeak} onValueChange={(value) => {
        setOffPeakTouched(true);
        setOffPeak(value);
      }} />
      <button data-testid="submit" onClick={submit}>Submit</button>
      <pre data-testid="payload">{payload}</pre>
    </main>
  </TooltipProvider></ZCodeIntlProvider>;
}

createRoot(document.getElementById("root")).render(<Fixture />);
`;
}

test(
  "独立浏览器验证自动化 Agent / Team 选择、回显与历史值不脏写",
  { timeout: 90_000 },
  async (t) => {
    // 只启动本测试自己的 Chromium 与临时 profile，不连接或操作正在运行的 YCode。
    const chromiumFixture = await loadChromium();
    if (!chromiumFixture) {
      t.skip("未找到独立 Chromium；可设置 ZCODE_TEST_CHROMIUM_PATH 后重跑自动化模式交互测试");
      return;
    }
    const { chromium, executablePath } = chromiumFixture;
    const [{ build }, { compile }] = await Promise.all([
      import("esbuild"),
      import("@tailwindcss/node"),
    ]);
    const directory = await mkdtemp(join(tmpdir(), "ycode-automation-mode-browser-"));
    try {
      const entry = join(directory, "entry.tsx");
      const bundle = join(directory, "fixture.js");
      await writeFile(entry, fixtureSource());
      await build({
        entryPoints: [entry],
        outfile: bundle,
        bundle: true,
        format: "iife",
        platform: "browser",
        jsx: "automatic",
        target: ["chrome120"],
        logLevel: "silent",
        nodePaths: [join(uiRoot, "node_modules"), join(uiRoot, "..", "..", "node_modules")],
        define: { "process.env.NODE_ENV": '"production"' },
        loader: {
          ".svg": "dataurl",
          ".png": "dataurl",
          ".jpg": "dataurl",
          ".webp": "dataurl",
          ".mp3": "dataurl",
          ".wav": "dataurl",
          ".woff": "dataurl",
          ".woff2": "dataurl",
        },
        plugins: [
          {
            name: "ui-source",
            setup(builder) {
              builder.onResolve({ filter: /^@\// }, async (args) => {
                const path = await resolveSource(resolve(uiRoot, "src", args.path.slice(2)));
                return path ? { path } : undefined;
              });
              builder.onResolve({ filter: /\.js$/ }, async (args) => {
                if (!args.path.startsWith(".")) return undefined;
                const path = await resolveSource(resolve(args.resolveDir, args.path));
                return path ? { path } : undefined;
              });
            },
          },
        ],
      });

      const context = await chromium.launchPersistentContext(join(directory, "profile"), {
        executablePath,
        headless: true,
        viewport: { width: 900, height: 760 },
      });
      try {
        const page = await context.newPage();
        // 关闭滚动标签动画，避免 AnimatePresence 在断言瞬间同时保留新旧两个文本。
        await page.emulateMedia({ reducedMotion: "reduce" });
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.setContent(
          '<!doctype html><html class="theme-zai-light"><head><script>globalThis.__name = value => value;</script></head><body><div id="root"></div></body></html>',
        );
        await page.addScriptTag({ path: bundle });

        const scheduled = page.getByTestId("scheduled-field").getByRole("combobox");
        const offPeak = page.getByTestId("offpeak-field").getByRole("combobox");
        const classNames = await page.evaluate(() => [
          ...new Set(
            [...document.querySelectorAll("[class]")].flatMap((element) => [...element.classList]),
          ),
        ]);
        // 探针类不在初始 DOM 里，显式加入编译集合后才能比较计算色。
        classNames.push("text-mode-agent!", "text-mode-team!");
        const sourceCss = await readFile(join(uiRoot, "src", "styles.css"), "utf8");
        const compiler = await compile(sourceCss, {
          base: join(uiRoot, "src"),
          onDependency: () => undefined,
        });
        await page.addStyleTag({ content: compiler.build(classNames) });
        await page.addStyleTag({
          content:
            "html,body{margin:0;background:var(--color-background);color:var(--color-foreground)}*{transition:none!important;animation:none!important}",
        });

        const readPayload = async () => JSON.parse(await page.getByTestId("payload").innerText());
        const expectTone = async (locator: typeof scheduled, mode: "yolo" | "team") => {
          const colors = await locator.evaluate(
            (element: HTMLElement, expectedClass: string) => {
              const probe = document.createElement("span");
              probe.className = `${expectedClass} text-warning`;
              document.body.append(probe);
              const expected = getComputedStyle(probe).color;
              probe.remove();
              return { actual: getComputedStyle(element).color, expected };
            },
            mode === "team" ? "text-mode-team!" : "text-mode-agent!",
          );
          assert.equal(colors.actual, colors.expected);
        };

        // 新建默认 Agent；不碰选择器直接提交时创建载荷仍显式带 yolo。
        assert.equal((await scheduled.innerText()).trim(), "Agent");
        assert.equal((await offPeak.innerText()).trim(), "Agent");
        await expectTone(scheduled, "yolo");
        await page.getByTestId("submit").click();
        assert.deepEqual(await readPayload(), { mode: "yolo", permissionMode: "yolo" });

        // 两个入口都只有 Agent / Team，且选择后身份色和文本同步。
        await scheduled.click();
        assert.equal(await page.getByRole("option").count(), 2);
        assert.equal(await page.getByTestId("chat-mode-select-item-plan").count(), 0);
        assert.equal(await page.getByTestId("chat-mode-select-item-readonly").count(), 0);
        await page.getByTestId("chat-mode-select-item-team").click();
        assert.equal((await scheduled.innerText()).trim(), "Team");
        await expectTone(scheduled, "team");

        await offPeak.click();
        await page.getByTestId("chat-mode-select-item-team").click();
        assert.equal((await offPeak.innerText()).trim(), "Team");
        await page.getByTestId("submit").click();
        assert.deepEqual(await readPayload(), { mode: "team", permissionMode: "team" });

        // 编辑已有 Team：回显 Team，未触碰时更新载荷不带档位，避免无关编辑迁移档位。
        await page.getByTestId("scenario-edit-team").click();
        assert.equal((await scheduled.innerText()).trim(), "Team");
        assert.equal((await offPeak.innerText()).trim(), "Team");
        await page.getByTestId("submit").click();
        assert.deepEqual(await readPayload(), {});

        // 历史 NULL / legacy 展示回退 Agent，同样不写回。
        await page.getByTestId("scenario-edit-legacy").click();
        assert.equal((await scheduled.innerText()).trim(), "Agent");
        assert.equal((await offPeak.innerText()).trim(), "Agent");
        await expectTone(scheduled, "yolo");
        await page.getByTestId("submit").click();
        assert.deepEqual(await readPayload(), {});

        // 显式改档才提交；只改定时表单时闲时字段保持省略。
        await page.getByTestId("scenario-edit-team").click();
        await scheduled.click();
        await page.getByTestId("chat-mode-select-item-yolo").click();
        assert.equal((await scheduled.innerText()).trim(), "Agent");
        await page.getByTestId("submit").click();
        assert.deepEqual(await readPayload(), { mode: "yolo" });

        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

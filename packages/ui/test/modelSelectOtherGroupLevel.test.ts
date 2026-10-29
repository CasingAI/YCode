import assert from "node:assert/strict";
import { constants, readFileSync } from "node:fs";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  TID_CHAT_MODEL_SELECT_GROUP,
  TID_CHAT_MODEL_SELECT_ITEM,
  TID_CHAT_MODEL_SELECT_TRIGGER,
  testId,
} from "@zcode/shared";

const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8").replace(/\r\n/g, "\n");

// 「其他」组的固定三层（docs/specs/provider-primary.md）：
// 主菜单「其他 >」→「其他」子菜单里的供应商入口 → 供应商子菜单里的模型。
// 分节标题不算层级；数量不改变层级，只有一个供应商/一条模型时也不扁平化。
//
// 前半部分按源码断言分支契约（快、无外部依赖）；后半部分用独立无头 Chromium
// 真正渲染 Radix 菜单，验证三个面板的内容归属、祖先勾选、Portal 逃逸与选中关闭。
// 浏览器用例只启动自己的临时 profile，不连接也不操作正在运行的 YCode。

function readOtherBranch(): { source: string; branch: string } {
  const source = read("../src/ModelConfigSelect.tsx");
  const start = source.indexOf("if (group.isOtherGroup) {");
  const end = source.indexOf("if (group.directItems) {");
  assert.ok(start >= 0 && end > start, "ModelConfigSelect 缺少 isOtherGroup 分支或分支顺序不对");
  return { source, branch: source.slice(start, end) };
}

test("「其他」分支排在 directItems 分支之前，且不再使用灰色标题", () => {
  const { source, branch } = readOtherBranch();
  assert.ok(
    source.indexOf("if (group.isOtherGroup) {") < source.indexOf("if (group.directItems) {"),
    "「其他」分支必须先于 directItems 分支判定",
  );
  // 第一层必须是可展开的入口，不能用 DropdownMenuLabel 冒充层级。
  assert.doesNotMatch(branch, /DropdownMenuLabel/);
});

test("三层嵌套顺序：其他入口 → 其他子菜单 → 供应商入口 → 供应商子菜单(Portal) → 模型", () => {
  const { branch } = readOtherBranch();
  const outerSub = branch.indexOf("<DropdownMenuSub>");
  const outerTrigger = branch.indexOf("data-model-provider-key={group.key}");
  const outerContent = branch.indexOf("<DropdownMenuSubContent");
  const providerSub = branch.indexOf("<DropdownMenuSub key={subSection.key}>");
  const providerTrigger = branch.indexOf("data-model-provider-key={subSection.key}");
  const portal = branch.indexOf("<DropdownMenuPortal>");
  const thirdContent = branch.indexOf("<DropdownMenuSubContent", providerTrigger);
  const modelItems = branch.indexOf("renderModelItems(subSection.items)");
  assert.ok(outerSub >= 0, "缺少「其他」外层 DropdownMenuSub");
  assert.ok(
    outerSub < outerTrigger && outerTrigger < outerContent,
    "「其他」入口必须是外层 SubTrigger，并先于它自己的 SubContent",
  );
  assert.ok(
    outerContent < providerSub && providerSub < providerTrigger,
    "供应商入口必须渲染在「其他」SubContent 内部",
  );
  assert.ok(
    providerTrigger < portal && portal < thirdContent && thirdContent < modelItems,
    "第三层模型必须由 Portal 包裹的 SubContent 承载",
  );
});

test("第二层只渲染供应商入口，不渲染合成组的平铺 items", () => {
  const { branch } = readOtherBranch();
  assert.match(branch, /<DropdownMenuSub key=\{subSection\.key\}>/);
  // 平铺 items 只用于「其他」入口的选中态；一旦出现在 render 里就会退回两层结构。
  assert.doesNotMatch(branch, /renderModelItems\(group\.items\)/);
  assert.doesNotMatch(branch, /subSections\.length > 0/);
  // 「其他」与供应商两个 ancestor trigger 都用各自的 items 判选中。
  assert.match(
    branch,
    /const otherSelected = isModelSelectGroupSelected\(\s*group,\s*normalizedValue,?\s*\)/,
  );
  assert.match(
    branch,
    /const subSectionSelected = isModelSelectGroupSelected\(\s*subSection,\s*normalizedValue,?\s*\)/,
  );
  assert.match(branch, /data-model-provider-selected=\{otherSelected \? "true" : undefined\}/);
  assert.match(
    branch,
    /data-model-provider-selected=\{\s*subSectionSelected \? "true" : undefined,?\s*\}/,
  );
});

// ---------------------------------------------------------------------------
// 真实渲染回归（独立无头 Chromium）
// ---------------------------------------------------------------------------

const desktopRequire = createRequire(new URL("../../desktop/package.json", import.meta.url));
const uiRoot = fileURLToPath(new URL("..", import.meta.url));
const sourcePath = (name: string) => JSON.stringify(join(uiRoot, "src", name).replace(/\\/g, "/"));

async function findChromium(bundledPath: string): Promise<string | undefined> {
  const directories = [
    process.env.PROGRAMFILES,
    process.env["PROGRAMFILES(X86)"],
    process.env.LOCALAPPDATA,
  ].filter((value): value is string => Boolean(value));
  const candidates = [
    process.env.ZCODE_TEST_CHROMIUM_PATH,
    process.env.CHROME_BIN,
    process.env.CHROMIUM_PATH,
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    bundledPath,
    ...[resolve("/", "Applications"), join(homedir(), "Applications")].flatMap((directory) => [
      join(directory, "Google Chrome.app", "Contents", "MacOS", "Google Chrome"),
      join(directory, "Chromium.app", "Contents", "MacOS", "Chromium"),
    ]),
    ...directories.flatMap((directory) => [
      join(directory, "Google", "Chrome", "Application", "chrome.exe"),
      join(directory, "Chromium", "Application", "chrome.exe"),
    ]),
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // 未安装独立浏览器时显式跳过，不连接运行中的应用或下载浏览器。
    }
  }
  return undefined;
}

async function resolveSource(candidate: string): Promise<string | undefined> {
  const stem = candidate.endsWith(".js") ? candidate.slice(0, -3) : candidate;
  for (const file of [
    candidate,
    ...[".ts", ".tsx", ".js", ".json"].map((ext) => `${stem}${ext}`),
  ]) {
    try {
      await access(file);
      return file;
    } catch {
      // 源码的 .js 导入在隔离 fixture 中解析到对应 TypeScript 文件。
    }
  }
  return undefined;
}

function fixtureSource(): string {
  return `
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ModelConfigSelect } from ${sourcePath("ModelConfigSelect.tsx")};

// 全部供应商都是 other：主菜单第一层只应出现「其他 >」，不能露出供应商或模型。
const manyGroups = [
  {
    key: "model-selection-other",
    label: "其他",
    isOtherGroup: true,
    items: [
      { key: "o1", value: "custom:opencode-model", name: "opencode-model" },
      { key: "o2", value: "custom:command-model", name: "command-model" },
      { key: "o3", value: "custom:minimax-model", name: "minimax-model" },
    ],
    subSections: [
      {
        key: "registry-provider:opencode",
        label: "OpenCode Go (Chat)",
        items: [{ key: "o1", value: "custom:opencode-model", name: "opencode-model" }],
      },
      {
        key: "registry-provider:command",
        label: "Command Code",
        items: [{ key: "o2", value: "custom:command-model", name: "command-model" }],
      },
      {
        key: "registry-provider:minimax",
        label: "MiniMax Token Plan",
        items: [{ key: "o3", value: "custom:minimax-model", name: "minimax-model" }],
      },
    ],
  },
];

// 只有一个 other 供应商、且只有一条模型：仍必须保留三层，不能自动平铺。
const singleGroups = [
  {
    key: "model-selection-other",
    label: "其他",
    isOtherGroup: true,
    items: [{ key: "s1", value: "custom:solo-model", name: "solo-model" }],
    subSections: [
      {
        key: "registry-provider:solo",
        label: "Solo Provider",
        items: [{ key: "s1", value: "custom:solo-model", name: "solo-model" }],
      },
    ],
  },
];

function Fixture() {
  const [single, setSingle] = useState(false);
  const [open, setOpen] = useState(true);
  const [value, setValue] = useState("custom:command-model");
  return (
    <>
      <button
        type="button"
        data-testid="scenario-many"
        onClick={() => {
          setSingle(false);
          setValue("custom:command-model");
          setOpen(true);
        }}
      >
        many
      </button>
      <button
        type="button"
        data-testid="scenario-single"
        onClick={() => {
          setSingle(true);
          setValue("custom:solo-model");
          setOpen(true);
        }}
      >
        single
      </button>
      <ModelConfigSelect
        modelGroups={single ? singleGroups : manyGroups}
        normalizedValue={value}
        triggerLabel="Select model"
        showManageModelsAction={false}
        lockReasonMessage="locked"
        isItemLocked={() => false}
        onValueChange={setValue}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}

createRoot(document.getElementById("root")).render(<Fixture />);
`;
}

test(
  "真实菜单：其他入口 → 供应商入口 → 模型三层，祖先勾选、Portal 未裁剪、选中关闭",
  { timeout: 120_000 },
  async (t) => {
    // 只启动本测试自己的 Chromium 与临时 profile，不连接或操作正在运行的 YCode。
    const { chromium } = desktopRequire("playwright-core") as typeof import("playwright-core");
    const executablePath = await findChromium(chromium.executablePath());
    if (!executablePath) {
      t.skip("未找到独立 Chromium；可设置 ZCODE_TEST_CHROMIUM_PATH 后重跑「其他」三层菜单渲染测试");
      return;
    }
    const [{ build }, { compile }] = await Promise.all([
      import("esbuild"),
      import("@tailwindcss/node"),
    ]);
    const directory = await mkdtemp(join(tmpdir(), "ycode-other-menu-browser-"));
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
        viewport: { width: 1000, height: 760 },
      });
      try {
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.setContent(
          '<!doctype html><html><head><script>globalThis.__name = value => value;</script></head><body><div id="root"></div></body></html>',
        );
        await page.addScriptTag({ path: bundle });

        const trigger = page.getByTestId(TID_CHAT_MODEL_SELECT_TRIGGER);
        const rootContent = page.locator('[data-slot="dropdown-menu-content"]');
        const otherTrigger = page.getByTestId(
          testId(TID_CHAT_MODEL_SELECT_GROUP, "model-selection-other"),
        );
        await rootContent.waitFor({ state: "visible" });

        // 第一层：只有「其他 >」入口，没有供应商名或模型。
        assert.equal(await otherTrigger.getAttribute("data-slot"), "dropdown-menu-sub-trigger");
        const firstLevelText = await rootContent.innerText();
        assert.ok(firstLevelText.includes("其他"));
        for (const hidden of [
          "OpenCode Go (Chat)",
          "Command Code",
          "MiniMax Token Plan",
          "opencode-model",
          "command-model",
          "minimax-model",
        ]) {
          assert.equal(firstLevelText.includes(hidden), false, `第一层不应出现 ${hidden}`);
        }
        assert.equal(await rootContent.locator('[data-slot="dropdown-menu-label"]').count(), 0);
        assert.equal(
          await rootContent.locator('[data-slot="dropdown-menu-radio-item"]').count(),
          0,
        );
        // 当前模型属于 Command Code：「其他」入口已带祖先勾选。
        assert.equal(await otherTrigger.getAttribute("data-model-provider-selected"), "true");

        // 第二层：只出现三个供应商入口，没有模型条目、没有灰色标题。
        await otherTrigger.click();
        const secondLevel = page.locator('[data-slot="dropdown-menu-sub-content"]:visible').first();
        await secondLevel.waitFor({ state: "visible" });
        const secondLevelText = await secondLevel.innerText();
        for (const provider of ["OpenCode Go (Chat)", "Command Code", "MiniMax Token Plan"]) {
          assert.ok(secondLevelText.includes(provider), `第二层缺少 ${provider}`);
        }
        for (const model of ["opencode-model", "command-model", "minimax-model"]) {
          assert.equal(secondLevelText.includes(model), false, `第二层不应出现模型 ${model}`);
        }
        assert.equal(await secondLevel.locator('[data-slot="dropdown-menu-label"]').count(), 0);
        assert.equal(
          await secondLevel.locator('[data-slot="dropdown-menu-radio-item"]').count(),
          0,
        );
        const providerTriggers = secondLevel.locator('[data-slot="dropdown-menu-sub-trigger"]');
        assert.equal(await providerTriggers.count(), 3);
        assert.equal((await providerTriggers.nth(1).innerText()).trim(), "Command Code");
        assert.equal(
          await providerTriggers.nth(1).getAttribute("data-model-provider-selected"),
          "true",
        );
        assert.equal(
          await providerTriggers.nth(0).getAttribute("data-model-provider-selected"),
          null,
        );
        assert.equal(await page.locator('[data-model-provider-selected="true"]').count(), 2);

        // 注入真实样式后再打开第三层，让 overflow 约束真实生效。
        const classes = await page.evaluate(() => [
          ...new Set(
            [...document.querySelectorAll("[class]")].flatMap((element) => [...element.classList]),
          ),
        ]);
        const sourceCss = await readFile(join(uiRoot, "src", "styles.css"), "utf8");
        const compiler = await compile(sourceCss, {
          base: join(uiRoot, "src"),
          onDependency: () => undefined,
        });
        await page.addStyleTag({ content: compiler.build(classes) });
        await page.addStyleTag({
          content:
            "html,body{margin:0;background:var(--color-background);color:var(--color-foreground)}",
        });

        // 第三层：只有 Command Code 自己的模型，且位于第二层滚动容器之外的 Portal。
        await providerTriggers.nth(1).click();
        const thirdLevel = page
          .locator('[data-slot="dropdown-menu-sub-content"]')
          .filter({ hasText: "command-model" });
        await thirdLevel.waitFor({ state: "visible" });
        assert.equal(await thirdLevel.locator('[data-slot="dropdown-menu-radio-item"]').count(), 1);
        const thirdLevelText = await thirdLevel.innerText();
        assert.ok(thirdLevelText.includes("command-model"));
        assert.equal(thirdLevelText.includes("opencode-model"), false);
        assert.equal(thirdLevelText.includes("minimax-model"), false);
        assert.equal(
          await page
            .getByTestId(testId(TID_CHAT_MODEL_SELECT_ITEM, "custom:command-model"))
            .count(),
          1,
        );
        // Portal 证据：第三层不是第二层 SubContent 的 DOM 后代（否则会被 overflow 裁剪）。
        assert.equal(
          await secondLevel.locator('[data-slot="dropdown-menu-sub-content"]').count(),
          0,
        );
        const secondHandle = await secondLevel.elementHandle();
        assert.ok(secondHandle);
        assert.equal(
          await thirdLevel.evaluate((element, second) => !second.contains(element), secondHandle),
          true,
        );
        const geometry = await thirdLevel.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const secondElement = document.querySelector('[data-slot="dropdown-menu-sub-content"]');
          const secondStyle = secondElement ? getComputedStyle(secondElement) : null;
          const hit = document.elementFromPoint(
            rect.left + Math.min(rect.width / 2, 20),
            rect.top + Math.min(rect.height / 2, 10),
          );
          return {
            insideViewport:
              rect.left >= 0 &&
              rect.top >= 0 &&
              rect.right <= window.innerWidth &&
              rect.bottom <= window.innerHeight,
            hitInside: Boolean(hit && element.contains(hit)),
            secondOverflowX: secondStyle?.overflowX ?? "",
            secondOverflowY: secondStyle?.overflowY ?? "",
          };
        });
        assert.equal(geometry.secondOverflowX, "hidden");
        assert.equal(geometry.secondOverflowY, "auto");
        assert.equal(geometry.hitInside, true);
        assert.equal(geometry.insideViewport, true);

        // 鼠标移入 Portal 后的第三层：子菜单必须保持打开，再点击选中并关闭整个菜单。
        const itemLocator = page.getByTestId(
          testId(TID_CHAT_MODEL_SELECT_ITEM, "custom:command-model"),
        );
        const itemBox = await itemLocator.boundingBox();
        assert.ok(itemBox);
        await page.mouse.move(itemBox.x + itemBox.width / 2, itemBox.y + itemBox.height / 2, {
          steps: 8,
        });
        await page.waitForTimeout(400);
        assert.equal(await thirdLevel.isVisible(), true);
        await page.mouse.down();
        await page.mouse.up();
        await rootContent.waitFor({ state: "detached" });
        assert.equal(
          await trigger.getAttribute("data-model-current-value"),
          "custom:command-model",
        );

        // 只有一个供应商、只有一条模型：仍保留三层，不自动平铺。
        await page.getByTestId("scenario-single").click();
        await rootContent.waitFor({ state: "visible" });
        const singleFirstText = await rootContent.innerText();
        assert.ok(singleFirstText.includes("其他"));
        assert.equal(singleFirstText.includes("Solo Provider"), false);
        assert.equal(singleFirstText.includes("solo-model"), false);
        await otherTrigger.click();
        const singleSecond = page
          .locator('[data-slot="dropdown-menu-sub-content"]:visible')
          .first();
        await singleSecond.waitFor({ state: "visible" });
        const singleSecondText = await singleSecond.innerText();
        assert.ok(singleSecondText.includes("Solo Provider"));
        assert.equal(singleSecondText.includes("solo-model"), false);
        const singleTriggers = singleSecond.locator('[data-slot="dropdown-menu-sub-trigger"]');
        assert.equal(await singleTriggers.count(), 1);
        await singleTriggers.nth(0).click();
        const singleThird = page
          .locator('[data-slot="dropdown-menu-sub-content"]')
          .filter({ hasText: "solo-model" });
        await singleThird.waitFor({ state: "visible" });
        assert.equal(
          await singleThird.locator('[data-slot="dropdown-menu-radio-item"]').count(),
          1,
        );
        assert.equal((await singleThird.innerText()).trim().includes("solo-model"), true);

        // Radix 原生键盘返回：Left 退回主菜单且保持打开，不额外维护菜单状态。
        await page.keyboard.press("ArrowLeft");
        await page
          .locator('[data-slot="dropdown-menu-sub-content"]')
          .first()
          .waitFor({ state: "detached" });
        assert.equal(await rootContent.isVisible(), true);
        assert.equal(await otherTrigger.isVisible(), true);

        await page.keyboard.press("Escape");
        await rootContent.waitFor({ state: "detached" });
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

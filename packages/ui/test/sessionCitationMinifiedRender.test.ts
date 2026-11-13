import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import test, { after, before } from "node:test";
import { pathToFileURL, fileURLToPath } from "node:url";
// 生产压缩会重命名 sanitize attacher，未压缩源码测试覆盖不到；这里用 Vite
// 生产默认压缩真实 message.tsx 管线后 SSR，验证 ycode 引用与敏感协议过滤。
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { build } from "vite";
import type { MessageResponse } from "../src/components/ai-elements/message.js";
import { TooltipProvider } from "../src/components/ui/tooltip.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const entryPoint = path.join(packageRoot, "src/components/ai-elements/message.tsx");

let outDir = "";
let BundledMessageResponse: typeof MessageResponse;

before(async () => {
  outDir = await mkdtemp(path.join(packageRoot, "node_modules", ".tmp-citation-minified-"));
  await build({
    configFile: false,
    root: packageRoot,
    logLevel: "silent",
    resolve: { alias: { "@": path.join(packageRoot, "src") } },
    ssr: {
      // 只把安全层相关依赖打进压缩产物，其余保持外部依赖；react 共享同一实例。
      noExternal: ["streamdown", "rehype-sanitize"],
      external: ["react", "react-dom", "react-dom/server", "react/jsx-runtime", "electron"],
    },
    build: {
      ssr: entryPoint,
      outDir,
      emptyOutDir: true,
      minify: true,
      rollupOptions: { output: { entryFileNames: "bundle.mjs", codeSplitting: false } },
    },
  });

  // 守卫测试前提：产物中的 sanitize attacher 必须已改名。若构建不压缩，
  // 本测试会退回“未覆盖生产形态”的假绿灯，这里直接拦住。
  const files = (await readdir(outDir, { recursive: true }))
    .filter((file) => file.endsWith(".js") || file.endsWith(".mjs"))
    .map((file) => path.join(outDir, file));
  const code = (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
  const sanitizeEntry = /sanitize:\[([^,\]]+)/.exec(code)?.[1]?.trim();
  assert.ok(sanitizeEntry, "压缩产物中缺少 sanitize 插件条目");
  const attacherName =
    /^(?:async\s+)?function\s+([A-Za-z0-9_$]+)/.exec(sanitizeEntry)?.[1] ?? sanitizeEntry;
  assert.notEqual(
    attacherName,
    "rehypeSanitize",
    "sanitize attacher 未被压缩改名，测试未覆盖生产压缩形态",
  );

  const bundled = (await import(pathToFileURL(path.join(outDir, "bundle.mjs")).href)) as {
    MessageResponse: typeof MessageResponse;
  };
  BundledMessageResponse = bundled.MessageResponse;
});

after(async () => {
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

function renderMinifiedMarkdown(markdown: string): string {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(
        TooltipProvider,
        null,
        createElement(
          BundledMessageResponse,
          {
            renderZCodeSessionCitations: true,
            sessionCitationExistingSessionIds: new Set(["sess_a"]),
            streaming: false,
            onOpenSessionCitation: () => {},
          },
          markdown,
        ),
      ),
    ),
  );
}

test("生产压缩后 ycode 会话引用仍渲染成可点芯片", () => {
  const markup = renderMinifiedMarkdown(
    "结论：[改过鉴权要点](ycode://session/open?sessionId=sess_a&search=改过鉴权要点) 完。",
  );
  assert.ok(!markup.includes("[blocked]"), `生产压缩后引用被拦截:\n${markup}`);
  assert.ok(markup.includes("<button"), `压缩后芯片不是可点按钮:\n${markup}`);
  assert.ok(markup.includes("改过鉴权要点"));
  assert.ok(markup.includes('title="sess_a"'));
  assert.ok(!markup.includes("ycode://"), `裸 URL 泄漏:\n${markup}`);
});

test("生产压缩后敏感协议链接仍被拦截", () => {
  for (const [scheme, url] of [
    ["javascript", "javascript:alert(1)"],
    ["data", "data:text/html;base64,PHNjcmlwdD4="],
    ["vbscript", "vbscript:msgbox"],
  ] as const) {
    const markup = renderMinifiedMarkdown(`[恶意](${url}) 完。`);
    assert.ok(markup.includes("恶意"), `${scheme} 链接文本丢失:\n${markup}`);
    assert.ok(!markup.includes("<button"), `${scheme} 链接不应可点:\n${markup}`);
    assert.ok(!markup.includes("<a "), `${scheme} 链接不应渲染 anchor:\n${markup}`);
    assert.ok(!markup.includes(`${scheme}:`), `${scheme} 协议泄漏:\n${markup}`);
  }
});

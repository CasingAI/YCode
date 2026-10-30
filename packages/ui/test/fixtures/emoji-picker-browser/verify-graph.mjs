import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { outputDir } from "./output-dir.mjs";

// 构建图验证：官方浏览器工具不可用时，证明两种模式下 emoji 数据模块图可解析、
// 无裸 JSON 说明符、产物无外部依赖。
//   node .../verify-graph.mjs
//   EMOJI_E2E_DEV_URL=http://127.0.0.1:43117 EMOJI_E2E_PROD_URL=http://127.0.0.1:43118 node .../verify-graph.mjs
const HERE = dirname(fileURLToPath(import.meta.url));
const UI_ROOT = resolve(HERE, "../../..");
const DIST = resolve(outputDir);
const DEV_URL = process.env.EMOJI_E2E_DEV_URL;
const PROD_URL = process.env.EMOJI_E2E_PROD_URL;

const results = [];
function pass(label) {
  results.push({ label, ok: true });
  console.log(`PASS ${label}`);
}

function readChunkImports(source) {
  const specs = new Set();
  const candidates = [];
  for (const match of source.matchAll(/(?<![\w$"'`.])from\s*[`"']([^`"']+)[`"']/g)) {
    candidates.push(match[1]);
  }
  for (const match of source.matchAll(/import\(\s*[`"']([^`"']+)[`"']\s*\)/g)) {
    candidates.push(match[1]);
  }
  // Vite preload 依赖数组里的 "./x.js" 同样是运行时会加载的 chunk。
  for (const match of source.matchAll(/[`"'](\.\/[^`"']+\.(?:js|css))[`"']/g)) {
    candidates.push(match[1]);
  }
  for (const spec of candidates) {
    // 压缩后的 CSS-in-JS 数据（如 Tailwind 的 "gradient-from") 里会包含
    // `from"..."` 片段，会被宽松的 from 正则误判成 import。真实模块说明符
    // 只由路径字符组成，且不会包含引号/括号/冒号/逗号等表达式字符。
    if (/^[A-Za-z0-9@._/\\:-]+$/.test(spec) && !spec.includes("\\")) {
      specs.add(spec);
    }
  }
  return [...specs];
}

function isBareSpecifier(spec) {
  return !spec.startsWith(".") && !spec.startsWith("/") && !spec.startsWith("data:");
}

async function verifyProductionChunks() {
  assert.ok(existsSync(DIST), `构建产物不存在: ${DIST}（先执行 vite build）`);
  const files = await readdir(join(DIST, "assets"));
  const panelFile = files.find((file) => /^emoji-picker-panel-.*\.js$/.test(file));
  const zhFile = files.find((file) => /^emojibase-data-zh-.*\.js$/.test(file));
  const enFile = files.find((file) => /^emojibase-data-en-.*\.js$/.test(file));
  const entryFile = files.find((file) => /^index-.*\.js$/.test(file));
  assert.ok(panelFile, "缺少 emoji-picker-panel 分包");
  assert.ok(zhFile, "缺少中文数据分包");
  assert.ok(enFile, "缺少英文数据分包");
  assert.ok(entryFile, "缺少入口分包");
  pass("生产构建按语言拆出独立数据分包（zh / en）");

  const panel = await readFile(join(DIST, "assets", panelFile), "utf8");
  assert.ok(!panel.includes("emojibase-data/"), "面板分包仍含裸 emojibase-data 说明符");
  assert.ok(
    panel.includes(`./${zhFile}`) && panel.includes(`./${enFile}`),
    "面板分包未把动态导入重写为实际 chunk",
  );
  pass("生产面板分包以相对路径引用 zh/en 数据 chunk，无裸 JSON import");
  assert.match(
    panel,
    /resolveEmojiData:[A-Za-z_$][\w$]*/,
    "面板未向 Frimousse 注入自定义 resolver",
  );
  pass("面板向真实 Frimousse 注入本地 resolveEmojiData（不走默认 CDN 解析器）");

  const zh = await readFile(join(DIST, "assets", zhFile), "utf8");
  const en = await readFile(join(DIST, "assets", enFile), "utf8");
  assert.ok(zh.startsWith("var ") && zh.includes("JSON.parse(`["), "中文 chunk 不是内联 JSON");
  assert.ok(zh.includes('"火箭"'), "中文数据 chunk 缺少火箭条目");
  assert.ok(en.includes('"rocket"'), "英文数据 chunk 缺少 rocket 条目");
  pass("zh/en 数据 chunk 已内联真实数据（含 火箭 / rocket）");

  const indexHtml = await readFile(join(DIST, "index.html"), "utf8");
  assert.ok(/assets\/index-.*\.js/.test(indexHtml), "index.html 未引用入口 chunk");
  pass("生产 index.html 引用入口 chunk");

  const visited = new Set();
  const queue = [entryFile, panelFile, zhFile, enFile];
  const allSpecs = [];
  while (queue.length > 0) {
    const file = queue.shift();
    if (visited.has(file)) continue;
    visited.add(file);
    const source = await readFile(join(DIST, "assets", file), "utf8");
    for (const spec of readChunkImports(source)) {
      allSpecs.push({ from: file, spec });
      if (spec.startsWith("./") && spec.endsWith(".js")) {
        queue.push(spec.slice(2));
      }
    }
  }
  const bare = allSpecs.filter(({ spec }) => isBareSpecifier(spec));
  assert.deepEqual(bare, [], `生产产物存在裸说明符: ${JSON.stringify(bare)}`);
  for (const file of visited) {
    assert.ok(existsSync(join(DIST, "assets", file)), `引用的 chunk 不存在: ${file}`);
  }
  pass(`生产模块图可解析（访问 ${visited.size} 个 chunk，全部本地存在且无裸说明符）`);

  const cssFile = files.find((file) => /^index-.*\.css$/.test(file));
  assert.ok(cssFile, "缺少打包样式");
  const css = await readFile(join(DIST, "assets", cssFile), "utf8");
  const cssUrls = [...css.matchAll(/url\(([^)]+)\)/g)]
    .map((match) => match[1].replace(/^["']|["']$/g, ""))
    .filter((url) => url.startsWith("./") || url.startsWith("/assets/"));
  for (const url of cssUrls) {
    const target = url.startsWith("/")
      ? join(DIST, url.replace(/^\//, ""))
      : join(DIST, "assets", url.replace(/^\.\//, ""));
    assert.ok(existsSync(target), `样式引用的资源不存在: ${url}`);
  }
  pass(`样式资源全部存在（${cssUrls.length} 个 url 引用）`);

  // Noto emoji：扁平输出 3,998 张独立 PNG，构建产物不得内联成 data URL。
  const notoDir = join(DIST, "noto-emoji");
  assert.ok(existsSync(notoDir), "缺少 noto-emoji 输出目录（插件未注册？）");
  const notoFiles = (await readdir(notoDir)).filter((file) => file.endsWith(".png")).sort();
  assert.equal(notoFiles.length, 3998, `noto-emoji PNG 数量异常: ${notoFiles.length}`);
  let notoBytes = 0;
  for (const file of notoFiles) {
    assert.match(file, /^emoji_u[0-9a-f]+(_[0-9a-f]+)*\.png$/, `PNG 文件名不符合规则: ${file}`);
    const bytes = await readFile(join(notoDir, file));
    assert.equal(
      bytes.subarray(0, 8).toString("hex"),
      "89504e470d0a1a0a",
      `${file} 不是有效 PNG（symlink 占位文本未被解析）`,
    );
    assert.equal(bytes.readUInt32BE(8), 13, `${file} 缺少有效 IHDR 块`);
    assert.equal(bytes.toString("ascii", 12, 16), "IHDR", `${file} 缺少 IHDR 类型`);
    assert.ok(bytes.readUInt32BE(16) > 0, `${file} IHDR 宽度无效`);
    assert.ok(bytes.readUInt32BE(20) > 0, `${file} IHDR 高度无效`);
    notoBytes += bytes.byteLength;
  }
  assert.equal(notoBytes, 16_541_769, `noto-emoji 总字节异常: ${notoBytes}`);
  assert.ok(
    !files.some((file) => file.endsWith(".png")),
    "PNG 出现在 assets/ 下，说明被 Vite 当普通资源处理",
  );
  pass(`noto-emoji 输出 3998 张独立 PNG（${notoBytes} 字节，未内联）`);

  const allJs = await Promise.all(
    files
      .filter((file) => file.endsWith(".js"))
      .map((file) => readFile(join(DIST, "assets", file), "utf8")),
  );
  const allJsText = allJs.join("\n");
  assert.ok(allJsText.includes("noto-emoji/"), "产物缺少本地 noto-emoji URL 前缀");
  assert.ok(allJsText.includes("emoji_u1f680"), "产物缺少资源 key 清单");
  assert.ok(!allJsText.includes("data:image/png;base64,"), "产物内联了 PNG data URL");
  pass("JS 只携带 URL 清单，未内联 PNG 二进制");
}

async function verifyProductionHttp() {
  if (!PROD_URL) return;
  const index = await fetch(`${PROD_URL}/`);
  assert.equal(index.status, 200);
  assert.match(index.headers.get("content-type") ?? "", /text\/html/);
  const html = await index.text();
  const urls = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1]);
  const assets = (await readdir(join(DIST, "assets"))).filter((file) =>
    /^(emoji-picker-panel|emojibase-data-(zh|en)|preload-helper)-.*\.js$/.test(file),
  );
  for (const url of [...urls, ...assets.map((file) => `/assets/${file}`)]) {
    if (!url.startsWith("/")) continue;
    const response = await fetch(`${PROD_URL}${url}`);
    assert.equal(response.status, 200, `生产资源 404: ${url}`);
  }
  const png = await fetch(`${PROD_URL}/noto-emoji/emoji_u1f680.png`);
  assert.equal(png.status, 200, "生产服务未提供本地 emoji PNG");
  assert.match(png.headers.get("content-type") ?? "", /image\/png/);
  assert.ok((await png.arrayBuffer()).byteLength > 0, "PNG 响应为空");
  pass(
    `生产静态服务可访问 index、${assets.length} 个关键 chunk 与本地 PNG（共 ${urls.length + assets.length + 1} 个请求）`,
  );
}

async function verifyDevGraph() {
  if (!DEV_URL) return;
  const uiPath = UI_ROOT.replaceAll("\\", "/");
  const panelUrl = `${DEV_URL}/@fs/${uiPath}/src/workspace-grouped-tasks/emoji-picker-panel.tsx`;
  const resolverUrl = `${DEV_URL}/@fs/${uiPath}/src/workspace-grouped-tasks/frimousse-local-data.ts`;
  const zhWrapperUrl = `${DEV_URL}/@fs/${uiPath}/src/workspace-grouped-tasks/emojibase-data-zh.ts`;
  const enWrapperUrl = `${DEV_URL}/@fs/${uiPath}/src/workspace-grouped-tasks/emojibase-data-en.ts`;

  const page = await fetch(`${DEV_URL}/`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.ok(html.includes("/main.tsx"), "开发页未加载 fixture 入口");
  pass("开发站点可访问并加载 fixture 入口");

  const panel = await (await fetch(panelUrl)).text();
  assert.ok(panel.includes("frimousse-local-data"), "面板未引用本地数据 resolver");
  pass("开发模式面板引用本地数据 resolver");

  const resolver = await (await fetch(resolverUrl)).text();
  assert.ok(!resolver.includes("emojibase-data/zh/data.json"), "resolver 仍直接动态导入裸 JSON");
  assert.ok(resolver.includes("emojibase-data-zh.ts"), "resolver 未动态导入中文 wrapper");
  assert.ok(resolver.includes("emojibase-data-en.ts"), "resolver 未动态导入英文 wrapper");
  pass("开发模式 resolver 仅动态导入 TS wrapper（zh/en）");

  for (const [name, url] of [
    ["zh", zhWrapperUrl],
    ["en", enWrapperUrl],
  ]) {
    const wrapper = await (await fetch(url)).text();
    const jsonMatches = [...wrapper.matchAll(/from "([^"]+\?import)"/g)].map((match) => match[1]);
    assert.equal(jsonMatches.length, 2, `${name} wrapper 未转换出两个 JSON 模块引用`);
    for (const jsonUrl of jsonMatches) {
      const response = await fetch(`${DEV_URL}${jsonUrl}`);
      assert.equal(response.status, 200, `${name} JSON 模块不可访问: ${jsonUrl}`);
      const contentType = response.headers.get("content-type") ?? "";
      assert.match(contentType, /javascript/, `${name} JSON 模块 MIME 非 JS: ${contentType}`);
      const body = await response.text();
      assert.ok(
        body.startsWith("export ") &&
          (body.includes("JSON.parse(") || body.includes("export const ")),
        `${name} JSON 模块不是 ESM: ${body.slice(0, 80)}`,
      );
    }
    pass(`开发模式 ${name} wrapper 的 data/messages JSON 以 text/javascript 模块提供`);
  }

  const devPng = await fetch(`${DEV_URL}/noto-emoji/emoji_u1f680.png`);
  assert.equal(devPng.status, 200, "开发中间件未提供本地 emoji PNG");
  assert.match(devPng.headers.get("content-type") ?? "", /image\/png/);
  assert.ok((await devPng.arrayBuffer()).byteLength > 0, "开发态 PNG 响应为空");
  pass("开发模式 noto-emoji 中间件按需提供本地 PNG");
}

await verifyProductionChunks();
await verifyProductionHttp();
await verifyDevGraph();
console.log(`\n全部 ${results.length} 项构建图断言通过。`);

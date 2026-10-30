import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "vite";

import { loadNotoEmojiAssets, notoEmojiAssetsPlugin } from "@zcode/ui/vite/noto-emoji-assets";

// 直接构建真实解析器入口：守护 Vite 8/Rolldown 对 import attributes 的处理，
// 避免再次生成 emojibase-data 裸动态 import（浏览器无法解析 → 永久「加载中」）。
const sourceEntry = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../src/workspace-grouped-tasks/frimousse-local-data.ts",
);
const uiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const notoAssetRoot = join(uiRoot, "src/assets/noto-emoji");
const notoAssetEntry = join(notoAssetRoot, "index.ts").replaceAll("\\", "/");
const EXPECTED_ASSET_COUNT = 3998;
const EXPECTED_ASSET_BYTES = 16_541_769;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function assertValidPng(fileName: string, bytes: Buffer): void {
  assert.ok(
    bytes.byteLength >= 33 && bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE),
    `${fileName} 不是有效 PNG（首 8 字节 ${bytes.subarray(0, 8).toString("utf8")}）；` +
      "region-flags 的 symlink 源文件必须在 vendoring 时跟随真实目标复制",
  );
  assert.equal(bytes.readUInt32BE(8), 13, `${fileName} 缺少有效 IHDR 块`);
  assert.equal(bytes.toString("ascii", 12, 16), "IHDR", `${fileName} 缺少 IHDR 类型`);
  assert.ok(bytes.readUInt32BE(16) > 0, `${fileName} IHDR 宽度无效`);
  assert.ok(bytes.readUInt32BE(20) > 0, `${fileName} IHDR 高度无效`);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("Vite 生产构建：locale 数据分块且不残留 emojibase 裸说明符", { timeout: 60_000 }, async () => {
  const outDir = await mkdtemp(join(tmpdir(), "zcode-emoji-build-"));

  try {
    // 入口带一个真实的副作用引用，避免 Vite 应用构建（preserveEntrySignatures: false）
    // 把未使用的入口导出整体摇掉，导致入口与动态 import 都不进产物。
    const entryPath = join(outDir, "entry.js");
    await writeFile(
      entryPath,
      `import { resolveLocalEmojiData } from ${JSON.stringify(sourceEntry.replaceAll("\\", "/"))};\n` +
        "globalThis.__zcodeResolveLocalEmojiData = resolveLocalEmojiData;\n",
      "utf8",
    );

    await build({
      configFile: false,
      logLevel: "silent",
      build: {
        outDir: join(outDir, "dist"),
        emptyOutDir: true,
        write: true,
        minify: false,
        target: "esnext",
        rollupOptions: {
          input: entryPath,
          output: {
            entryFileNames: "entry.js",
            chunkFileNames: "[name]-[hash].js",
          },
        },
      },
    });

    const distDir = join(outDir, "dist");
    const files = (await readdir(distDir)).filter((file) => file.endsWith(".js"));
    assert.ok(files.includes("entry.js"), "构建产物缺少 entry.js");

    const codeByName = new Map<string, string>();
    for (const file of files) {
      codeByName.set(file, await readFile(join(distDir, file), "utf8"));
    }

    for (const [file, code] of codeByName) {
      assert.doesNotMatch(
        code,
        /(?:import\s*\(\s*|from\s*)[`"']emojibase-data\//,
        `${file} 残留 emojibase-data 裸说明符`,
      );
    }

    const entry = codeByName.get("entry.js");
    assert.ok(entry, "entry.js 缺失");

    const zhChunk = files.find(
      (file) => file !== "entry.js" && codeByName.get(file)?.includes("火箭"),
    );
    const enChunk = files.find(
      (file) => file !== "entry.js" && codeByName.get(file)?.includes("rocket"),
    );
    assert.ok(zhChunk, "缺少包含 zh 表情数据的 locale chunk");
    assert.ok(enChunk, "缺少包含 en 表情数据的 locale chunk");

    for (const chunk of new Set([zhChunk, enChunk])) {
      const code = codeByName.get(chunk) ?? "";
      assert.ok(code.length > 100_000, `${chunk} 体积异常，疑似未打入数据`);
      assert.match(
        entry,
        new RegExp(`[\\\`"']\\./${escapeRegExp(chunk)}[\\\`"']`),
        `entry.js 未引用 ${chunk}`,
      );
    }
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test("资源锁被篡改时构建门禁拒绝（不会把坏资源打进产物）", async () => {
  const fakeRoot = await mkdtemp(join(tmpdir(), "zcode-emoji-lock-"));
  try {
    // 只写锁、不写资源：load 必须在 totals 校验阶段就失败，
    // 防止后续构建误用总量/来源不一致的资源目录。
    await writeFile(
      join(fakeRoot, "noto-emoji.lock.json"),
      JSON.stringify({
        formatVersion: 1,
        source: {
          repository: "https://github.com/googlefonts/noto-emoji",
          tag: "v2026-09-24-unicode18_0",
          commit: "e20cbc2bbec1926686be9f9bee7d1d2cfa1fea0e",
        },
        rules: { filePattern: "emoji_u<codepoint>.png" },
        totals: { files: 1, bytes: 1 },
        licenses: {},
        manifestSha256: "",
        files: {},
      }),
      "utf8",
    );
    await assert.rejects(
      async () => loadNotoEmojiAssets(fakeRoot),
      /总量不匹配|来源 tag\/commit/,
      "篡改后的资源锁未被拒绝",
    );
  } finally {
    await rm(fakeRoot, { recursive: true, force: true });
  }
});

test(
  "Vite 构建经 notoEmojiAssetsPlugin 输出全量独立 PNG，不内联",
  { timeout: 180_000 },
  async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "zcode-emoji-assets-build-"));
    const distDir = join(outputRoot, "dist");

    try {
      const entryPath = join(outputRoot, "entry.js");
      await writeFile(
        entryPath,
        `import { emojiAssetUrl, hasEmojiAsset } from ${JSON.stringify(notoAssetEntry)};\n` +
          'globalThis.__zcodeEmojiAssets = [emojiAssetUrl("\\u{1F680}"), hasEmojiAsset("\\u{1F680}"), hasEmojiAsset("\\u{10FFFD}")];\n',
        "utf8",
      );

      await build({
        configFile: false,
        root: uiRoot,
        logLevel: "silent",
        plugins: [notoEmojiAssetsPlugin()],
        build: {
          outDir: distDir,
          emptyOutDir: true,
          write: true,
          minify: false,
          target: "esnext",
          assetsInlineLimit: 0,
          rollupOptions: {
            input: entryPath,
            output: {
              entryFileNames: "entry.js",
              chunkFileNames: "[name]-[hash].js",
            },
          },
        },
      });

      // 1. 3,998 张 PNG 全部作为独立静态文件输出，文件名/字节数与资源锁一致。
      const pngFiles = (await readdir(join(distDir, "noto-emoji"))).sort();
      assert.equal(pngFiles.length, EXPECTED_ASSET_COUNT, "PNG 文件数不等于资源锁");
      let totalBytes = 0;
      for (const fileName of pngFiles) {
        assert.match(fileName, /^emoji_u[0-9a-f]+(_[0-9a-f]+)*\.png$/);
        const bytes = await readFile(join(distDir, "noto-emoji", fileName));
        assertValidPng(fileName, bytes);
        totalBytes += bytes.byteLength;
      }
      assert.equal(totalBytes, EXPECTED_ASSET_BYTES, "PNG 总字节数不等于资源锁");
      assert.equal(new Set(pngFiles).size, EXPECTED_ASSET_COUNT);

      const distTopLevel = await readdir(distDir);
      assert.ok(distTopLevel.includes("noto-emoji"), "缺少 noto-emoji 输出目录");
      // entryFileNames 固定为 "entry.js" 时 Rolldown 把入口写在 dist 根，不生成
      // assets/；有分包时才出现 assets/。两处都要纳入检查，不能假定 assets 一定存在。
      assert.ok(
        !distTopLevel.some((file) => file.endsWith(".png")),
        "PNG 被 Vite 当作普通资源处理后放在产物根目录",
      );
      const assetsDir = join(distDir, "assets");
      const assetFiles = existsSync(assetsDir) ? await readdir(assetsDir) : [];
      assert.ok(
        !assetFiles.some((file) => file.endsWith(".png")),
        "PNG 被 Vite 当作普通资源处理后内联/改名，未保持独立静态文件",
      );

      // 2. 入口 chunk 只携带 URL 清单，不含图片二进制或 data URL。
      const scriptPaths = [
        ...distTopLevel.filter((file) => file.endsWith(".js")).map((file) => join(distDir, file)),
        ...assetFiles.filter((file) => file.endsWith(".js")).map((file) => join(assetsDir, file)),
      ];
      const scripts = await Promise.all(scriptPaths.map((file) => readFile(file, "utf8")));
      const allScripts = scripts.join("\n");
      assert.match(allScripts, /noto-emoji\//, "产物缺少本地 noto-emoji URL 前缀");
      assert.match(allScripts, /emoji_u1f680/, "产物缺少资源 key 清单");
      for (const [index, code] of scripts.entries()) {
        assert.doesNotMatch(
          code,
          /data:image\/png;base64,/,
          `${scriptPaths[index]} 内联了 PNG 数据`,
        );
      }

      // 3. 资源锁读取结果与产物 key 集合一致。
      const lockedAssets = await loadNotoEmojiAssets(notoAssetRoot);
      assert.deepEqual(
        lockedAssets.map((asset) => `${asset.key}.png`).sort(),
        pngFiles,
        "产物 key 集合与资源锁不一致",
      );
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  },
);

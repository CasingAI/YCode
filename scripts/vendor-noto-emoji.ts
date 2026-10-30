#!/usr/bin/env node
/* eslint-disable max-lines -- vendor 需集中维护 git tree 解析、PNG 内容门禁与锁生成，拆分会让复现步骤分散。 */
/**
 * Vendor 官方 Noto Emoji PNG72 与 region-flags，并生成资源锁与纯 key 索引。
 *
 * 用法（Node 24，仓库根目录）：
 *   mise exec -- pnpm exec tsx scripts/vendor-noto-emoji.ts --source <官方 checkout>
 *
 * 该脚本只读取本地官方 checkout，不联网；checkout 必须精确指向锁定的
 * noto-emoji tag/commit。资源只复制 emojibase-data 实际需要的 key，
 * 其余上游文件（例如独立 keycap 组件）不进入仓库。
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ASSET_ROOT = join(REPO_ROOT, "packages", "ui", "src", "assets", "noto-emoji");
const NOTO_DIR = join(ASSET_ROOT, "noto");
const FLAGS_DIR = join(ASSET_ROOT, "flags");
const LICENSE_DIR = join(ASSET_ROOT, "LICENSES");
const LOCK_PATH = join(ASSET_ROOT, "noto-emoji.lock.json");
const KEY_INDEX_PATH = join(ASSET_ROOT, "keys.ts");

const EXPECTED_COMMIT = "e20cbc2bbec1926686be9f9bee7d1d2cfa1fea0e";
const EXPECTED_TAG = "v2026-09-24-unicode18_0";
const EXPECTED_TOTAL_FILES = 3998;
const EXPECTED_TOTAL_BYTES = 16_541_769;
const EXPECTED_NOTO_FILES = 3736;
const EXPECTED_FLAG_FILES = 262;
const EXPECTED_NOTO_SOURCE_FILES = 3750;
const EXPECTED_FLAG_SOURCE_FILES = 359;
const EXPECTED_TOTAL_DATA_KEYS = 3998;
const COPY_CONCURRENCY = 32;
const FLAG_SOURCE_TREE_PREFIX = "third_party/region-flags/png";
// 这些路径的字节会被复制或作为许可证据保留；必须与固定 commit 完全一致。
const CONTROLLED_SOURCE_PATHS = [
  "2D/png/72",
  "2D/svg/LICENSE",
  "AUTHORS",
  "LICENSE",
  "third_party/region-flags/png",
  "third_party/region-flags/LICENSE",
  "third_party/region-flags/README.third_party",
] as const;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const TAG_FLAGS = new Map([
  ["emoji_u1f3f4_e0067_e0062_e0065_e006e_e0067_e007f", "GB-ENG"],
  ["emoji_u1f3f4_e0067_e0062_e0073_e0063_e0074_e007f", "GB-SCT"],
  ["emoji_u1f3f4_e0067_e0062_e0077_e006c_e0073_e007f", "GB-WLS"],
]);

interface RawEmoji {
  emoji: string;
  skins?: { emoji: string }[];
}

interface SelectedAsset {
  key: string;
  collection: "noto" | "flags";
  sourcePath: string;
  sourceBytes?: Buffer;
}

interface GitTreeEntry {
  mode: string;
  type: string;
  object: string;
  path: string;
}

type EmojibaseDataset = RawEmoji[];

function fail(message: string): never {
  throw new Error(message);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** 构建与 vendor 共用的最低 PNG 内容门禁：签名、IHDR 和正尺寸。 */
function assertPng(relativePath: string, bytes: Buffer): void {
  if (bytes.byteLength < 33 || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    fail(`PNG 签名或头部长度无效: ${relativePath}`);
  }
  if (bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR") {
    fail(`PNG 缺少有效 IHDR 块: ${relativePath}`);
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width === 0 || height === 0) {
    fail(`PNG IHDR 尺寸无效: ${relativePath} (${width}x${height})`);
  }
}

/** 有限并发，避免复制/哈希 3,998 个文件时耗尽句柄。 */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await worker(item);
    }
  });
  await Promise.all(runners);
  return results;
}

function parseSourceArgument(): string {
  const index = process.argv.indexOf("--source");
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) {
    fail("缺少 --source <官方 noto-emoji checkout>");
  }
  const source = resolve(value);
  if (!existsSync(join(source, "2D", "png", "72"))) {
    fail(`source 不是有效的 noto-emoji checkout: ${source}`);
  }
  return source;
}

/** 与 packages/ui/src/assets/noto-emoji/key.ts 保持同一口径。 */
function assetKey(value: string): string | null {
  const codepoints = Array.from(value)
    .map((character) => character.codePointAt(0))
    .filter((codepoint): codepoint is number => codepoint !== undefined)
    .filter((codepoint) => codepoint !== 0xfe0f && codepoint !== 0xfe0e)
    .map((codepoint) => codepoint.toString(16).padStart(4, "0"));
  return codepoints.length > 0 ? `emoji_u${codepoints.join("_")}` : null;
}

function keyFromNotoFilename(filename: string): string {
  const match = /^(emoji_u[0-9a-f_]+)\.png$/.exec(filename);
  if (!match) {
    fail(`非法的 Noto 文件名: ${filename}`);
  }
  const key = match[1];
  if (!key) {
    fail(`无法提取 Noto 文件名 key: ${filename}`);
  }
  return key;
}

async function readDatasetKeys(locale: "zh" | "en"): Promise<Set<string>> {
  const require = createRequire(join(REPO_ROOT, "packages", "ui", "package.json"));
  const dataPath = require.resolve(`emojibase-data/${locale}/data.json`);
  const dataset = JSON.parse(await readFile(dataPath, "utf8")) as EmojibaseDataset;
  const keys = new Set<string>();
  for (const entry of dataset) {
    for (const value of [entry.emoji, ...(entry.skins ?? []).map((skin) => skin.emoji)]) {
      const key = assetKey(value);
      if (key) {
        keys.add(key);
      }
    }
  }
  return keys;
}

function assertSameKeys(label: string, expected: Set<string>, actual: Set<string>): void {
  const missing = [...expected].filter((key) => !actual.has(key));
  const extra = [...actual].filter((key) => !expected.has(key));
  if (missing.length > 0 || extra.length > 0) {
    fail(
      `${label} 与 emojibase 数据不一致：missing=${missing.length} [${missing
        .slice(0, 5)
        .join(", ")}], extra=${extra.length} [${extra.slice(0, 5).join(", ")}]`,
    );
  }
}

function isoCodeFromFlagKey(key: string): string | null {
  const codepoints = key
    .slice("emoji_u".length)
    .split("_")
    .map((part) => Number.parseInt(part, 16));
  if (
    codepoints.length !== 2 ||
    !codepoints.every((codepoint) => codepoint >= 0x1f1e6 && codepoint <= 0x1f1ff)
  ) {
    return null;
  }
  return String.fromCharCode(...codepoints.map((codepoint) => 0x41 + codepoint - 0x1f1e6));
}

async function readSourceFiles(directory: string, label: string): Promise<string[]> {
  const files = (await readdir(directory)).filter((filename) => filename.endsWith(".png")).sort();
  if (files.length === 0) {
    fail(`${label} 目录没有 PNG: ${directory}`);
  }
  return files;
}

/**
 * HEAD 匹配固定 commit 还不足以证明复制内容来自该 commit；受控路径若非干净，
 * 工作区字节可能来自未提交修改，不能标成固定 upstream。
 */
async function assertCleanSource(git: (args: string[]) => Promise<string>): Promise<void> {
  const status = await git([
    "status",
    "--porcelain",
    "--untracked-files=all",
    "--",
    ...CONTROLLED_SOURCE_PATHS,
  ]);
  if (status) {
    fail(`源 checkout 受控路径存在未提交改动，拒绝 vendor:\n${status}`);
  }
}

/**
 * core.symlinks=false 的 Windows checkout 会把 mode 120000 存成内容为目标的普通文本。
 * 因此不能相信工作区 flags 文件，必须从固定 commit 的 git tree 解析。
 */
async function readGitTree(
  git: (args: string[]) => Promise<string>,
  prefix: string,
): Promise<Map<string, GitTreeEntry>> {
  const output = await git(["ls-tree", "-r", "--full-tree", "HEAD", "--", prefix]);
  const entries = new Map<string, GitTreeEntry>();
  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;
    const match = /^(\d{6}) (\w+) ([0-9a-f]+)\t(.+)$/.exec(line);
    if (!match) {
      fail(`无法解析 git tree 条目: ${line}`);
    }
    const [, mode, type, object, path] = match;
    if (!mode || !type || !object || !path) {
      fail(`git tree 条目字段不完整: ${line}`);
    }
    entries.set(path, { mode, type, object, path });
  }
  return entries;
}

async function resolveFlagSource(
  sourceDirectory: string,
  filename: string,
  tree: Map<string, GitTreeEntry>,
  gitBinary: (args: string[]) => Promise<Buffer>,
): Promise<{ sourcePath: string; sourceBytes?: Buffer }> {
  const sourcePath = `${FLAG_SOURCE_TREE_PREFIX}/${filename}`;
  const entry = tree.get(sourcePath);
  if (!entry) {
    fail(`git tree 缺少旗帜文件: ${sourcePath}`);
  }
  if (entry.mode !== "120000") {
    if (entry.mode !== "100644" || entry.type !== "blob") {
      fail(`旗帜源不是普通文件或合法 symlink: ${sourcePath} (mode ${entry.mode})`);
    }
    return { sourcePath: join(sourceDirectory, filename) };
  }

  const target = (await gitBinary(["cat-file", "blob", entry.object])).toString("utf8");
  // 只接受同目录下的单层 PNG 目标，拒绝绝对路径、目录、换行和 symlink 链。
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.png$/.test(target)) {
    fail(`symlink 目标不是相对单层 PNG: ${sourcePath} -> ${JSON.stringify(target)}`);
  }
  const targetPath = `${FLAG_SOURCE_TREE_PREFIX}/${target}`;
  const targetEntry = tree.get(targetPath);
  if (!targetEntry) {
    fail(`symlink 目标不存在: ${sourcePath} -> ${targetPath}`);
  }
  if (targetEntry.mode !== "100644" || targetEntry.type !== "blob") {
    fail(`symlink 目标不是普通文件: ${sourcePath} -> ${targetPath} (mode ${targetEntry.mode})`);
  }
  const sourceBytes = await gitBinary(["cat-file", "blob", targetEntry.object]);
  return { sourcePath: join(sourceDirectory, target), sourceBytes };
}

async function main(): Promise<void> {
  const source = parseSourceArgument();
  const git = async (args: string[]): Promise<string> => {
    const { stdout } = await execFileAsync("git", ["-C", source, ...args], { encoding: "utf8" });
    return stdout.trim();
  };
  const gitBinary = async (args: string[]): Promise<Buffer> => {
    const result = await execFileAsync("git", ["-C", source, ...args], {
      encoding: null,
      maxBuffer: 64 * 1024 * 1024,
    });
    return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout);
  };

  const commit = await git(["rev-parse", "HEAD"]);
  if (commit !== EXPECTED_COMMIT) {
    fail(`source commit 不匹配：期望 ${EXPECTED_COMMIT}，实际 ${commit}`);
  }
  const tags = (await git(["tag", "--points-at", "HEAD"])).split(/\r?\n/);
  if (!tags.includes(EXPECTED_TAG)) {
    fail(`source HEAD 未指向 ${EXPECTED_TAG}`);
  }
  await assertCleanSource(git);

  const notoSourceDir = join(source, "2D", "png", "72");
  const flagSourceDir = join(source, "third_party", "region-flags", "png");
  const [notoSourceFiles, flagSourceFiles] = await Promise.all([
    readSourceFiles(notoSourceDir, "Noto"),
    readSourceFiles(flagSourceDir, "region-flags"),
  ]);
  if (notoSourceFiles.length !== EXPECTED_NOTO_SOURCE_FILES) {
    fail(`Noto PNG 数量不匹配：${notoSourceFiles.length}`);
  }
  if (flagSourceFiles.length !== EXPECTED_FLAG_SOURCE_FILES) {
    fail(`region-flags PNG 数量不匹配：${flagSourceFiles.length}`);
  }
  const flagTree = await readGitTree(git, FLAG_SOURCE_TREE_PREFIX);
  const flagTreePngCount = [...flagTree.values()].filter((entry) =>
    entry.path.endsWith(".png"),
  ).length;
  if (flagTreePngCount !== EXPECTED_FLAG_SOURCE_FILES) {
    fail(`git tree 中 region-flags PNG 数量不匹配：${flagTreePngCount}`);
  }

  const [zhKeys, enKeys] = await Promise.all([readDatasetKeys("zh"), readDatasetKeys("en")]);
  if (zhKeys.size !== EXPECTED_TOTAL_DATA_KEYS || enKeys.size !== EXPECTED_TOTAL_DATA_KEYS) {
    fail(`emojibase key 数量不是 ${EXPECTED_TOTAL_DATA_KEYS}: zh=${zhKeys.size} en=${enKeys.size}`);
  }
  assertSameKeys("zh/en", zhKeys, enKeys);

  const notoByKey = new Map<string, string>();
  for (const filename of notoSourceFiles) {
    notoByKey.set(keyFromNotoFilename(filename), join(notoSourceDir, filename));
  }

  const selected: SelectedAsset[] = [];
  const resolvedFlagSymlinks: string[] = [];
  for (const key of [...enKeys].sort()) {
    const notoPath = notoByKey.get(key);
    if (notoPath) {
      selected.push({ key, collection: "noto", sourcePath: notoPath });
      continue;
    }
    const sourceName = isoCodeFromFlagKey(key) ?? TAG_FLAGS.get(key);
    if (!sourceName) {
      fail(`emojibase key 既无 Noto PNG 也无旗帜映射: ${key}`);
    }
    const resolved = await resolveFlagSource(
      flagSourceDir,
      `${sourceName}.png`,
      flagTree,
      gitBinary,
    );
    if (resolved.sourceBytes) {
      resolvedFlagSymlinks.push(`${sourceName}.png`);
    }
    selected.push({
      key,
      collection: "flags",
      sourcePath: resolved.sourcePath,
      sourceBytes: resolved.sourceBytes,
    });
  }

  const selectedNotoCount = selected.filter((asset) => asset.collection === "noto").length;
  const selectedFlagCount = selected.length - selectedNotoCount;
  if (selectedNotoCount !== EXPECTED_NOTO_FILES) {
    fail(`选中的 Noto PNG 数量不匹配：${selectedNotoCount}`);
  }
  if (selectedFlagCount !== EXPECTED_FLAG_FILES) {
    fail(`选中的旗帜 PNG 数量不匹配：${selectedFlagCount}`);
  }

  const ignoredNoto = [...notoByKey.keys()].filter((key) => !enKeys.has(key)).sort();
  if (ignoredNoto.length !== 14) {
    fail(`未被 emojibase 使用的 Noto PNG 数量不匹配：${ignoredNoto.length}`);
  }

  await Promise.all([
    rm(NOTO_DIR, { recursive: true, force: true }),
    rm(FLAGS_DIR, { recursive: true, force: true }),
    rm(LICENSE_DIR, { recursive: true, force: true }),
  ]);
  await Promise.all([
    mkdir(NOTO_DIR, { recursive: true }),
    mkdir(FLAGS_DIR, { recursive: true }),
    mkdir(LICENSE_DIR, { recursive: true }),
  ]);

  const written = await mapLimit(selected, COPY_CONCURRENCY, async (asset) => {
    const relativePath = `${asset.collection}/${asset.key}.png`;
    const destination = join(ASSET_ROOT, relativePath);
    let bytes: Buffer;
    if (asset.sourceBytes) {
      bytes = asset.sourceBytes;
      await writeFile(destination, bytes);
    } else {
      await copyFile(asset.sourcePath, destination);
      bytes = await readFile(destination);
    }
    assertPng(relativePath, bytes);
    return { relativePath, byteLength: bytes.byteLength, sha256: sha256(bytes) };
  });
  const files = Object.fromEntries(
    written
      .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
      .map((file) => [file.relativePath, file.sha256]),
  );
  const totalBytes = written.reduce((total, file) => total + file.byteLength, 0);
  if (totalBytes !== EXPECTED_TOTAL_BYTES) {
    fail(`资源总字节不匹配：期望 ${EXPECTED_TOTAL_BYTES}，实际 ${totalBytes}`);
  }

  const licenseCopies: [source: string, destination: string][] = [
    [join(source, "2D", "svg", "LICENSE"), "Apache-2.0.txt"],
    [join(source, "LICENSE"), "OFL-1.1.txt"],
    [join(source, "AUTHORS"), "AUTHORS"],
    [join(source, "third_party", "region-flags", "LICENSE"), "region-flags-LICENSE.txt"],
    [
      join(source, "third_party", "region-flags", "README.third_party"),
      "region-flags-README.third_party",
    ],
  ];
  await mapLimit(licenseCopies, licenseCopies.length, async ([sourcePath, destinationName]) => {
    const info = await stat(sourcePath).catch(() => null);
    if (!info?.isFile()) {
      fail(`缺少许可原文: ${sourcePath}`);
    }
    // 许可文本统一规范为 LF，避免 Windows/Linux 检出时 inventory 文件哈希漂移。
    const text = await readFile(sourcePath, "utf8");
    await writeFile(join(LICENSE_DIR, destinationName), text.replaceAll("\r\n", "\n"));
  });

  const sortedEntries = Object.entries(files).sort(([left], [right]) => left.localeCompare(right));
  const manifestHash = createHash("sha256");
  for (const [file, hash] of sortedEntries) {
    manifestHash.update(`${file}\t${hash}\n`);
  }
  const keyIndex = sortedEntries.map(([file]) =>
    file.replace(/^(?:noto|flags)\//, "").replace(/\.png$/, ""),
  );
  if (keyIndex.length !== EXPECTED_TOTAL_FILES || new Set(keyIndex).size !== keyIndex.length) {
    fail(`资源 key 数量或唯一性不匹配：${keyIndex.length}`);
  }

  const lock = {
    formatVersion: 1,
    source: {
      repository: "https://github.com/googlefonts/noto-emoji",
      tag: EXPECTED_TAG,
      commit: EXPECTED_COMMIT,
      notoPngDirectory: "2D/png/72",
      regionFlagsPngDirectory: "third_party/region-flags/png",
      regionFlagsUpstreamRevision: "743e1f4a92b7d2dac49d7e6af509af63a71f0b45",
      sourceFileCounts: {
        notoPng: EXPECTED_NOTO_SOURCE_FILES,
        regionFlagsPng: EXPECTED_FLAG_SOURCE_FILES,
      },
      usedFileCounts: {
        notoPng: EXPECTED_NOTO_FILES,
        regionFlagsPng: EXPECTED_FLAG_FILES,
      },
    },
    rules: {
      fileName: "emoji_u<codepoint>[_<codepoint>...].png",
      filePattern: "^emoji_u[0-9a-f]+(_[0-9a-f]+)*\\.png$",
      codepointHex: 'lowercase, padStart(4, "0")',
      stripCodepoints: ["fe0f", "fe0e"],
      preserveCodepoints: ["200d", "tag characters"],
    },
    totals: {
      files: EXPECTED_TOTAL_FILES,
      bytes: EXPECTED_TOTAL_BYTES,
      notoFiles: EXPECTED_NOTO_FILES,
      flagFiles: EXPECTED_FLAG_FILES,
      emojibaseDataKeys: EXPECTED_TOTAL_DATA_KEYS,
      ignoredNotoPng: ignoredNoto,
    },
    licenses: {
      notoImages: {
        spdx: "Apache-2.0",
        text: "LICENSES/Apache-2.0.txt",
        upstreamFile: "2D/svg/LICENSE",
        note: "官方 README 说明图片资源为 Apache-2.0；字体目录为 OFL-1.1，但字体文件不在本资源目录，也不随应用打包。",
      },
      notoFont: {
        spdx: "OFL-1.1",
        text: "LICENSES/OFL-1.1.txt",
        upstreamFile: "LICENSE",
        included: false,
      },
      regionFlags: {
        spdx: "Public Domain",
        text: "LICENSES/region-flags-LICENSE.txt",
        upstreamFile: "third_party/region-flags/LICENSE",
      },
    },
    manifestSha256: manifestHash.digest("hex"),
    files,
  };
  await writeFile(LOCK_PATH, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
  await writeFile(
    KEY_INDEX_PATH,
    [
      "/* eslint-disable max-lines -- 生成的完整资源 key 清单，按锁文件逐项校验。 */",
      "// Generated by scripts/vendor-noto-emoji.ts. Do not edit manually.",
      "// Source: googlefonts/noto-emoji v2026-09-24-unicode18_0 (e20cbc2bbec1926686be9f9bee7d1d2cfa1fea0e).",
      `export const NOTO_EMOJI_ASSET_COUNT = ${keyIndex.length};`,
      "",
      "export const NOTO_EMOJI_ASSET_KEYS: readonly string[] = [",
      ...keyIndex.map((key) => `  ${JSON.stringify(key)},`),
      "];",
      "",
    ].join("\n"),
    "utf8",
  );

  const relativeRoot = relative(REPO_ROOT, ASSET_ROOT).replaceAll("\\", "/");
  console.log(
    `[noto-emoji] ${keyIndex.length} files, ${totalBytes} bytes -> ${relativeRoot}; ` +
      `noto=${EXPECTED_NOTO_FILES}, flags=${EXPECTED_FLAG_FILES}`,
  );
  console.log(`[noto-emoji] manifestSha256=${lock.manifestSha256}`);
  console.log(`[noto-emoji] ignored Noto components: ${ignoredNoto.join(", ")}`);
  if (resolvedFlagSymlinks.length > 0) {
    console.log(`[noto-emoji] resolved git symlinks: ${resolvedFlagSymlinks.join(", ")}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Plugin } from "vite";

import { emojiAssetKey } from "../src/assets/noto-emoji/key.ts";

const ASSET_DIRECTORY_NAME = "noto-emoji";
const OUTPUT_DIRECTORY = "noto-emoji";
const LOCK_FILE_NAME = "noto-emoji.lock.json";
const EXPECTED_REPOSITORY = "https://github.com/googlefonts/noto-emoji";
const EXPECTED_TAG = "v2026-09-24-unicode18_0";
const EXPECTED_COMMIT = "e20cbc2bbec1926686be9f9bee7d1d2cfa1fea0e";
const EXPECTED_FILE_COUNT = 3998;
const EXPECTED_BYTE_COUNT = 16_541_769;
const EXPECTED_DATA_KEY_COUNT = 3998;
const FILE_NAME_RE = /^emoji_u[0-9a-f]+(_[0-9a-f]+)*\.png$/;
const READ_CONCURRENCY = 32;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface LockFile {
  formatVersion: number;
  source: {
    repository: string;
    tag: string;
    commit: string;
  };
  rules: {
    filePattern: string;
  };
  totals: {
    files: number;
    bytes: number;
  };
  licenses: Record<string, { text: string }>;
  manifestSha256: string;
  files: Record<string, string>;
}

interface RawEmojiEntry {
  emoji: string;
  skins?: { emoji: string }[];
}

interface LoadedFile {
  relativePath: string;
  key: string;
  hash: string;
  bytes: Buffer;
}

export interface NotoEmojiAsset {
  key: string;
  relativePath: string;
  fileName: string;
  bytes: Buffer;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** 锁/哈希一致不能证明内容可解码；每个资源必须是带有效 IHDR 的 PNG。 */
function assertValidPng(relativePath: string, bytes: Buffer): void {
  if (bytes.byteLength < 33 || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error(`noto-emoji PNG 签名或头部长度无效: ${relativePath}`);
  }
  if (bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error(`noto-emoji PNG 缺少有效 IHDR 块: ${relativePath}`);
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width === 0 || height === 0) {
    throw new Error(`noto-emoji PNG IHDR 尺寸无效: ${relativePath} (${width}x${height})`);
  }
}

/**
 * 有限并发读取/哈希，避免一次性打开 3,998 个文件触发 EMFILE。
 * 结果按输入顺序返回；worker 抛错时 Promise 会终止其余仍在排队的读取。
 */
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

/**
 * 从当前工作目录或 Vite root 向上查找资源目录，避免依赖 Vite 配置被临时打包后的
 * `import.meta.url`（DevTools/CI 下不可靠）。
 */
export function resolveNotoEmojiAssetRoot(startDirectory = process.cwd()): string {
  let current = resolve(startDirectory);
  for (;;) {
    const candidate = join(current, "packages", "ui", "src", "assets", ASSET_DIRECTORY_NAME);
    if (existsSync(join(candidate, LOCK_FILE_NAME))) {
      return candidate;
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(`找不到 ${ASSET_DIRECTORY_NAME} 资源目录（起点 ${startDirectory}）`);
    }
    current = parent;
  }
}

function resolveInside(root: string, relativePath: string): string {
  const normalizedRoot = resolve(root);
  const target = resolve(normalizedRoot, relativePath);
  const fromRoot = relative(normalizedRoot, target);
  // 锁文件中的许可路径只能是资源目录内的相对路径，防止目录穿越读取任意文件。
  if (fromRoot === ".." || fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error(`noto-emoji 资源路径越界: ${relativePath}`);
  }
  if (isAbsolute(relativePath)) {
    throw new Error(`noto-emoji 资源路径不能是绝对路径: ${relativePath}`);
  }
  return target;
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}

async function readDataKeys(locale: "zh" | "en", repositoryRoot: string): Promise<Set<string>> {
  const require = createRequire(join(repositoryRoot, "packages", "ui", "package.json"));
  const dataPath = require.resolve(`emojibase-data/${locale}/data.json`);
  const entries = await readJson<RawEmojiEntry[]>(dataPath);
  const keys = new Set<string>();
  for (const entry of entries) {
    for (const value of [entry.emoji, ...(entry.skins ?? []).map((skin) => skin.emoji)]) {
      const key = emojiAssetKey(value);
      if (key) {
        keys.add(key);
      }
    }
  }
  return keys;
}

function assertSetsEqual(label: string, expected: Set<string>, actual: Set<string>): void {
  const missing = [...expected].filter((key) => !actual.has(key));
  const extra = [...actual].filter((key) => !expected.has(key));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `${label} 与 emojibase 数据不一致：missing=${missing.length} [${missing
        .slice(0, 5)
        .join(", ")}], extra=${extra.length} [${extra.slice(0, 5).join(", ")}]`,
    );
  }
}

async function listAssetFiles(assetRoot: string): Promise<string[]> {
  const directoryNames = ["noto", "flags"] as const;
  const groups = await Promise.all(
    directoryNames.map(async (directoryName) => {
      const directory = join(assetRoot, directoryName);
      const entries = await readdir(directory, { withFileTypes: true });
      return entries.map((entry) => {
        if (!entry.isFile()) {
          throw new Error(`noto-emoji 资源目录存在非文件项: ${directoryName}/${entry.name}`);
        }
        if (!FILE_NAME_RE.test(entry.name)) {
          throw new Error(`noto-emoji 文件名不符合规则: ${directoryName}/${entry.name}`);
        }
        return `${directoryName}/${entry.name}`;
      });
    }),
  );
  return groups.flat();
}

/**
 * 全量校验资源锁、文件名、哈希、字节数以及 zh/en emojibase 覆盖。
 * 返回的 Buffer 只在构建期用于 emit，不进入浏览器产物。
 *
 * 文件读取使用 32 路有限并发；Node 与 Vite 构建不会同时打开 3,998 个句柄。
 */
export async function loadNotoEmojiAssets(
  assetRoot = resolveNotoEmojiAssetRoot(),
): Promise<NotoEmojiAsset[]> {
  const lock = await readJson<LockFile>(join(assetRoot, LOCK_FILE_NAME));
  if (lock.formatVersion !== 1) {
    throw new Error(`不支持的 noto-emoji 锁版本: ${lock.formatVersion}`);
  }
  if (
    lock.source.repository !== EXPECTED_REPOSITORY ||
    lock.source.tag !== EXPECTED_TAG ||
    lock.source.commit !== EXPECTED_COMMIT
  ) {
    throw new Error("noto-emoji 锁的来源 tag/commit 与锁定值不一致");
  }
  if (lock.totals.files !== EXPECTED_FILE_COUNT || lock.totals.bytes !== EXPECTED_BYTE_COUNT) {
    throw new Error(
      `noto-emoji 锁总量不匹配：files=${lock.totals.files}, bytes=${lock.totals.bytes}`,
    );
  }

  const relativePaths = await listAssetFiles(assetRoot);
  if (relativePaths.length !== EXPECTED_FILE_COUNT) {
    throw new Error(`noto-emoji 文件数不匹配：${relativePaths.length}`);
  }

  const loaded = await mapLimit(relativePaths, READ_CONCURRENCY, async (relativePath) => {
    const bytes = await readFile(resolveInside(assetRoot, relativePath));
    assertValidPng(relativePath, bytes);
    const hash = sha256(bytes);
    const expectedHash = lock.files[relativePath];
    if (!expectedHash || expectedHash !== hash) {
      throw new Error(`noto-emoji 文件哈希不匹配或锁外文件: ${relativePath}`);
    }
    return {
      relativePath,
      key: basename(relativePath).replace(/\.png$/, ""),
      hash,
      bytes,
    } satisfies LoadedFile;
  });

  const sorted = loaded.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const actualKeys = new Set(sorted.map((file) => file.key));
  if (actualKeys.size !== sorted.length) {
    throw new Error("noto-emoji key 重复");
  }
  const totalBytes = sorted.reduce((total, file) => total + file.bytes.byteLength, 0);
  if (totalBytes !== lock.totals.bytes || totalBytes !== EXPECTED_BYTE_COUNT) {
    throw new Error(`noto-emoji 字节数不匹配：${totalBytes}`);
  }
  if (Object.keys(lock.files).length !== sorted.length) {
    throw new Error("noto-emoji 锁中存在目录外文件记录");
  }

  const manifest = createHash("sha256");
  for (const file of sorted) {
    manifest.update(`${file.relativePath}\t${file.hash}\n`);
  }
  if (manifest.digest("hex") !== lock.manifestSha256) {
    throw new Error("noto-emoji 目录清单哈希不匹配");
  }

  for (const license of Object.values(lock.licenses)) {
    if (typeof license?.text !== "string" || license.text.length === 0) {
      throw new Error("noto-emoji 锁缺少许可原文路径");
    }
    const licensePath = resolveInside(assetRoot, license.text);
    const info = await stat(licensePath).catch(() => null);
    if (!info?.isFile() || info.size === 0) {
      throw new Error(`noto-emoji 许可原文缺失: ${license.text}`);
    }
  }

  const repositoryRoot = resolve(assetRoot, "../../../../..");
  const [zhKeys, enKeys] = await Promise.all([
    readDataKeys("zh", repositoryRoot),
    readDataKeys("en", repositoryRoot),
  ]);
  if (zhKeys.size !== EXPECTED_DATA_KEY_COUNT || enKeys.size !== EXPECTED_DATA_KEY_COUNT) {
    throw new Error(
      `emojibase key 数量不匹配：zh=${zhKeys.size}, en=${enKeys.size}，期望 ${EXPECTED_DATA_KEY_COUNT}`,
    );
  }
  assertSetsEqual("zh/en", zhKeys, enKeys);
  assertSetsEqual("noto-emoji 与 emojibase", enKeys, actualKeys);

  return sorted.map(({ relativePath, key, bytes }) => ({
    key,
    relativePath,
    fileName: `${OUTPUT_DIRECTORY}/${key}.png`,
    bytes,
  }));
}

/**
 * 两端共享的 Noto emoji 资源插件：
 * - buildStart 校验锁/哈希/覆盖率（失败阻止构建）；
 * - generateBundle 以固定扁平文件名 emit，确保 3,998 张图是独立静态文件；
 * - configureServer 在开发态直接提供同一批 PNG。
 */
export function notoEmojiAssetsPlugin(): Plugin {
  let assetRoot = "";
  let isBuild = false;
  let assetsPromise: Promise<NotoEmojiAsset[]> | null = null;
  let assetsByKey = new Map<string, NotoEmojiAsset>();

  const ensureAssets = (): Promise<NotoEmojiAsset[]> => {
    assetsPromise ??= loadNotoEmojiAssets(assetRoot)
      .then((loaded) => {
        assetsByKey = new Map(loaded.map((asset) => [asset.key, asset]));
        return loaded;
      })
      .catch((error: unknown) => {
        // 失败不缓存，开发态下一次请求可以重试；构建态仍由 buildStart 直接失败。
        assetsPromise = null;
        throw error;
      });
    return assetsPromise;
  };

  return {
    name: "zcode:noto-emoji-assets",
    configResolved(config) {
      isBuild = config.command === "build";
      assetRoot = resolveNotoEmojiAssetRoot(config.root);
    },
    async buildStart() {
      // 开发态由中间件按需加载；生产构建在这里先门禁，失败即终止。
      if (isBuild) {
        await ensureAssets();
      }
    },
    async generateBundle() {
      for (const asset of await ensureAssets()) {
        this.emitFile({
          type: "asset",
          fileName: asset.fileName,
          source: asset.bytes,
        });
      }
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.method !== "GET" && request.method !== "HEAD") {
          next();
          return;
        }
        const requestPath = request.url?.split("?", 1)[0] ?? "";
        const marker = `/${OUTPUT_DIRECTORY}/`;
        const markerIndex = requestPath.indexOf(marker);
        if (markerIndex < 0) {
          next();
          return;
        }
        const fileName = requestPath.slice(markerIndex + marker.length);
        // 只接受单层、规则内文件名；反斜杠、百分号编码和 `..` 一律不进入查找。
        if (fileName !== basename(fileName) || !FILE_NAME_RE.test(fileName)) {
          next();
          return;
        }
        void ensureAssets()
          .then(() => {
            const asset = assetsByKey.get(fileName.replace(/\.png$/, ""));
            if (!asset) {
              response.statusCode = 404;
              response.end();
              return;
            }
            response.statusCode = 200;
            response.setHeader("Content-Type", "image/png");
            response.setHeader("Content-Length", String(asset.bytes.byteLength));
            response.setHeader("Cache-Control", "no-cache");
            if (request.method === "HEAD") {
              response.end();
              return;
            }
            response.end(asset.bytes);
          })
          .catch(next);
      });
    },
  };
}

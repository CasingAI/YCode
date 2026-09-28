#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = import.meta.dirname;
const workspaceDir = resolve(moduleDir, "../../..");
const defaultPackageJsonPath = resolve(workspaceDir, "package.json");

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;
// 定点替换用：只命中 package.json 里第一个 "version" 字段的值，保留原有缩进与键序。
const VERSION_FIELD_PATTERN = /("version"\s*:\s*")(\d+\.\d+\.\d+)(")/;

/**
 * 每次桌面端 build 都把产品版本的小版本号 +1，让同一天内的多个构建产物各自带唯一版本。
 * 只递增 patch，major/minor 留给 release-it 按 conventional commits 决定，构建期不越权。
 * 版本号在构建期的唯一用途是区分产物：关于面板、遥测、安装包 metadata、CDN 寻址
 * 都从这一份 package.json version 派生，所以只改这一处即可让全链路生效。
 */
export function bumpPatchVersion(version) {
  if (typeof version !== "string") {
    throw new Error(`Version must be a string, received ${typeof version}`);
  }

  const trimmed = version.trim();
  const matched = VERSION_PATTERN.exec(trimmed);
  if (!matched) {
    throw new Error(
      `Version must match <major>.<minor>.<patch>, received "${version}". ` +
        "Pre-release and build metadata suffixes are not accepted here.",
    );
  }

  const [, major, minor, patch] = matched;
  return `${major}.${minor}.${Number(patch) + 1}`;
}

export function bumpPackageVersion(
  packageJsonPath = defaultPackageJsonPath,
  { dryRun = false } = {},
) {
  const source = readFileSync(packageJsonPath, "utf8");
  const packageJson = JSON.parse(source);
  const nextVersion = bumpPatchVersion(packageJson.version);

  if (!dryRun) {
    // 用解析再序列化回写会重排键序、丢掉原有缩进习惯，package.json 的 diff 会被无关噪声淹没。
    // 这里只做定点替换，让版本号改动在 git diff 里始终是一行。
    // 命中的字段值必须等于解析出来的 version，否则说明正则匹配到了别的 "version" 键（例如
    // 嵌套依赖对象），此时宁可不写盘也不能改错位置。
    const match = VERSION_FIELD_PATTERN.exec(source);
    if (!match || match[2] !== packageJson.version) {
      throw new Error(
        `Unable to locate the top-level "version" field in ${packageJsonPath}; ` +
          "refusing to write so the bump cannot land on the wrong key.",
      );
    }

    const nextSource = source.replace(
      VERSION_FIELD_PATTERN,
      (_, prefix, _version, suffix) => `${prefix}${nextVersion}${suffix}`,
    );
    writeFileSync(packageJsonPath, nextSource, "utf8");
  }

  return { previousVersion: packageJson.version, version: nextVersion, packageJsonPath };
}

function parseArgs(argv) {
  const options = { dryRun: false, packageJsonPath: defaultPackageJsonPath };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--package") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("Missing value for --package");
      }
      options.packageJsonPath = resolve(value);
      index += 1;
    } else if (arg.startsWith("--package=")) {
      options.packageJsonPath = resolve(arg.slice("--package=".length));
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

const entryFilePath = process.argv[1] ? resolve(process.argv[1]) : null;

if (entryFilePath && entryFilePath === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = bumpPackageVersion(options.packageJsonPath, { dryRun: options.dryRun });
    const suffix = options.dryRun ? " (dry-run)" : "";
    process.stdout.write(
      `[bump-version] ${result.packageJsonPath} ${result.previousVersion} -> ${result.version}${suffix}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `[bump-version] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

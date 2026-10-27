import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import test from "node:test";
import {
  collectRuntimeModuleClosure,
  collectRuntimeModuleClosureEntries,
} from "../scripts/runtime-dependency-closure.mjs";

const desktopRoot = resolve(import.meta.dirname, "..");
const workspaceRoot = resolve(desktopRoot, "..", "..");
const runtimeModuleLookupRoots = [
  desktopRoot,
  workspaceRoot,
  resolve(desktopRoot, "node_modules", ".pnpm", "node_modules"),
  resolve(workspaceRoot, "node_modules", ".pnpm", "node_modules"),
];
const allowedModuleParentRoots = [
  resolve(workspaceRoot, "node_modules"),
  resolve(desktopRoot, "node_modules"),
];

function writeJsonFile(filePath: string, value: unknown) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writePackage(packageRoot: string, packageJson: Record<string, unknown>) {
  writeJsonFile(join(packageRoot, "package.json"), packageJson);
  writeFileSync(join(packageRoot, "index.js"), "module.exports = {};\n", "utf8");
}

function createFixtureWorkspace(prefix: string) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), prefix));
  writeJsonFile(join(fixtureRoot, "package.json"), {
    name: "fixture-workspace",
    private: true,
  });
  return fixtureRoot;
}

function assertInsideModuleRoots(sourceModulePath: string | null, label: string) {
  assert.equal(typeof sourceModulePath, "string", `${label} 应解析到确定的 package 目录`);
  const absolutePath = resolve(sourceModulePath);
  assert.ok(isAbsolute(absolutePath), `${label} 必须是绝对路径，实际: ${sourceModulePath}`);
  assert.notEqual(absolutePath, resolve("."), `${label} 不能退化成 cwd`);
  assert.notEqual(absolutePath, resolve(workspaceRoot), `${label} 不能是仓库根`);
  assert.notEqual(absolutePath, resolve(desktopRoot), `${label} 不能是 desktop 包根`);
  assert.ok(
    allowedModuleParentRoots.some((root) => {
      const relativePath = relative(root, absolutePath);
      return relativePath !== "" && !relativePath.startsWith(`..${sep}`) && relativePath !== "..";
    }),
    `${label} 应位于 node_modules 内，实际: ${absolutePath}`,
  );
}

test("Node 内置模块名（buffer/fs/node:crypto）不会沿 cwd 冒充 npm 包", () => {
  const fixtureRoot = createFixtureWorkspace("zcode-runtime-closure-builtin-");
  try {
    // 即使 fixture 里真的放了 npm buffer，Node 运行时仍会优先用内置模块。
    writePackage(join(fixtureRoot, "node_modules", "buffer"), {
      name: "buffer",
      version: "6.0.3",
      main: "index.js",
    });

    const entries = collectRuntimeModuleClosureEntries(
      ["buffer", "fs", "node:crypto"],
      [fixtureRoot],
    );

    assert.deepEqual(entries, []);
  } finally {
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
});

test("父包依赖里的内置模块名被跳过，不会把仓库根或 fixture 根当成依赖", () => {
  const fixtureRoot = createFixtureWorkspace("zcode-runtime-closure-parent-");
  try {
    writePackage(join(fixtureRoot, "node_modules", "buffer"), {
      name: "buffer",
      version: "6.0.3",
      main: "index.js",
    });
    writePackage(join(fixtureRoot, "node_modules", "alpha"), {
      name: "alpha",
      main: "index.js",
      dependencies: {
        beta: "1.0.0",
        buffer: "6.0.3",
        fs: "0.0.1-security",
        "node:crypto": "1.0.0",
      },
    });
    writePackage(join(fixtureRoot, "node_modules", "beta"), {
      name: "beta",
      main: "index.js",
      dependencies: {},
    });

    const entries = collectRuntimeModuleClosureEntries(["alpha"], [fixtureRoot]);

    assert.deepEqual(
      entries.map((entry) => entry.moduleName),
      ["alpha", "beta"],
    );
    for (const entry of entries) {
      assert.ok(isAbsolute(entry.sourceModulePath), `${entry.moduleName} 必须是绝对路径`);
      assert.notEqual(resolve(entry.sourceModulePath), fixtureRoot);
      assert.ok(
        !relative(fixtureRoot, resolve(entry.sourceModulePath)).startsWith(`..${sep}`),
        `${entry.moduleName} 不应落到 fixture 根之外`,
      );
      assert.ok(
        relative(join(fixtureRoot, "node_modules"), resolve(entry.sourceModulePath)) !== "",
        `${entry.moduleName} 不能是 fixture 根`,
      );
    }
    assert.ok(entries.every((entry) => entry.moduleName !== "buffer"));
  } finally {
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
});

test("正常依赖、optional 缺失、必需缺失与父包相对版本解析保持原有语义", () => {
  const fixtureRoot = createFixtureWorkspace("zcode-runtime-closure-fixture-");
  try {
    writePackage(join(fixtureRoot, "node_modules", "alpha"), {
      name: "alpha",
      main: "index.js",
      dependencies: {
        beta: "1.0.0",
        delta: "1.0.0",
        shared: "1.0.0",
      },
      optionalDependencies: {
        "missing-optional": "1.0.0",
      },
    });
    writePackage(join(fixtureRoot, "node_modules", "beta"), {
      name: "beta",
      main: "index.js",
      dependencies: {
        gamma: "1.0.0",
        shared: "2.0.0",
      },
    });
    // beta 需要 shared@2，根 node_modules 里是 shared@1；必须按父包 package.json 解析。
    writePackage(join(fixtureRoot, "node_modules", "beta", "node_modules", "shared"), {
      name: "shared",
      version: "2.0.0",
      main: "index.js",
    });
    writePackage(join(fixtureRoot, "node_modules", "beta", "node_modules", "gamma"), {
      name: "gamma",
      version: "1.0.0",
      main: "index.js",
    });
    writePackage(join(fixtureRoot, "node_modules", "shared"), {
      name: "shared",
      version: "1.0.0",
      main: "index.js",
    });

    const entries = collectRuntimeModuleClosureEntries(["alpha"], [fixtureRoot]);

    assert.deepEqual(
      entries.map((entry) => entry.moduleName),
      ["alpha", "beta", "gamma", "shared", "delta"],
    );
    assert.deepEqual(
      collectRuntimeModuleClosure(["alpha"], [fixtureRoot]),
      entries.map((entry) => entry.moduleName),
    );

    const byName = new Map(entries.map((entry) => [entry.moduleName, entry]));
    assert.equal(byName.get("alpha").sourceModulePath, join(fixtureRoot, "node_modules", "alpha"));
    assert.equal(byName.get("beta").sourceModulePath, join(fixtureRoot, "node_modules", "beta"));
    assert.equal(
      byName.get("gamma").sourceModulePath,
      join(fixtureRoot, "node_modules", "beta", "node_modules", "gamma"),
    );
    // 多版本同名依赖：取父包实际会加载的版本，而不是 lookup roots 里的第一个。
    assert.equal(
      byName.get("shared").sourceModulePath,
      join(fixtureRoot, "node_modules", "beta", "node_modules", "shared"),
    );
    // 必需依赖缺失仍需进入闭包（sourceModulePath=null），交给上层缺包告警/校验。
    assert.equal(byName.get("delta").sourceModulePath, null);
    assert.equal(byName.has("missing-optional"), false);
  } finally {
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
});

test("包内嵌套 package.json 不会被误当成包根，目录名不匹配的包也不会冒充模块", () => {
  const fixtureRoot = createFixtureWorkspace("zcode-runtime-closure-nested-");
  try {
    const nestedRoot = join(fixtureRoot, "node_modules", "nested-meta");
    writeJsonFile(join(nestedRoot, "package.json"), {
      name: "nested-meta",
      version: "1.0.0",
      main: "./build/cjs/index.js",
    });
    mkdirSync(join(nestedRoot, "build", "cjs"), { recursive: true });
    writeJsonFile(join(nestedRoot, "build", "cjs", "package.json"), { type: "commonjs" });
    writeFileSync(join(nestedRoot, "build", "cjs", "index.js"), "module.exports = {};\n", "utf8");
    writePackage(join(fixtureRoot, "node_modules", "fake-name"), {
      name: "other-package",
      version: "1.0.0",
      main: "index.js",
    });

    const nestedEntries = collectRuntimeModuleClosureEntries(["nested-meta"], [fixtureRoot]);
    assert.equal(nestedEntries.length, 1);
    assert.equal(nestedEntries[0].sourceModulePath, nestedRoot);

    const mismatchedEntries = collectRuntimeModuleClosureEntries(["fake-name"], [fixtureRoot]);
    assert.equal(mismatchedEntries.length, 1);
    assert.equal(mismatchedEntries[0].sourceModulePath, null);
  } finally {
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
});

test("werift 真实闭包完整、无缺失且不包含仓库根路径", () => {
  const entries = collectRuntimeModuleClosureEntries(["werift"], runtimeModuleLookupRoots);

  assert.ok(entries.length >= 30, `werift 闭包条目过少: ${entries.length}`);
  assert.equal(entries[0].moduleName, "werift");
  assert.deepEqual(
    collectRuntimeModuleClosure(["werift"], runtimeModuleLookupRoots),
    entries.map((entry) => entry.moduleName),
  );

  const missing = entries.filter((entry) => !entry.sourceModulePath);
  assert.deepEqual(
    missing.map((entry) => entry.moduleName),
    [],
    "werift 闭包不应有缺失模块",
  );

  for (const entry of entries) {
    assertInsideModuleRoots(entry.sourceModulePath, entry.moduleName);
  }

  const names = new Set(entries.map((entry) => entry.moduleName));
  // buffer 是内置模块名，npm 同名包不会被 Node 运行时加载。
  assert.equal(names.has("buffer"), false);
  // 旧 bug 会把仓库根 package.json 当成 buffer 的包根，继而把仓库根依赖也收进闭包。
  assert.equal(names.has("border-beam"), false);
  assert.equal(names.has("d3-path"), false);
  assert.equal(names.has("tailwind-scrollbar-hide"), false);

  // 嵌套子依赖与父包版本解析仍在闭包内。
  for (const expected of ["debug", "ms", "multicast-dns", "dns-packet", "@peculiar/utils"]) {
    assert.ok(names.has(expected), `werift 闭包应包含 ${expected}`);
  }
  const peculiarUtils = entries.find((entry) => entry.moduleName === "@peculiar/utils");
  // @peculiar/utils/build/cjs/package.json 只是 type 标记，包根必须是包目录本身。
  assert.equal(
    peculiarUtils.sourceModulePath,
    resolve(workspaceRoot, "node_modules", "@peculiar", "utils"),
  );
  const debug = entries.find((entry) => entry.moduleName === "debug");
  // werift 固定 debug@4.4.0，父包相对解析应命中 werift 自带版本。
  assert.equal(
    debug.sourceModulePath,
    resolve(workspaceRoot, "node_modules", "werift", "node_modules", "debug"),
  );
});

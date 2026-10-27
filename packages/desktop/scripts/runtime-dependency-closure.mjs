import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, parse, resolve } from "node:path";
import { createRequire, isBuiltin } from "node:module";

function readPackageJson(packageJsonPath) {
  try {
    return JSON.parse(readFileSync(packageJsonPath, "utf8"));
  } catch {
    return null;
  }
}

function findPackageRoot(entryPath, expectedName) {
  // 从入口向上找到 name 与依赖名一致的 package.json，而不是“最近的一个”。
  // 包内可能有只声明 { "type": "commonjs" } 的嵌套 package.json
  // （例如 @peculiar/utils/build/cjs/package.json），把它当成包根会把依赖复制到子目录。
  // 同时用 name 校验兜底，防止解析结果意外落到别的包或仓库根。
  let currentDir = dirname(entryPath);
  const root = parse(currentDir).root;
  for (;;) {
    const packageJsonPath = resolve(currentDir, "package.json");
    if (existsSync(packageJsonPath)) {
      const packageJson = readPackageJson(packageJsonPath);
      if (packageJson?.name === expectedName) {
        return { packageJson, packageJsonPath, packageRoot: currentDir };
      }
    }

    if (currentDir === root) {
      return null;
    }
    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }
    currentDir = parentDir;
  }
}

function readRuntimePackage(moduleLookupRoots, moduleName, parentPackagePath = null) {
  if (parentPackagePath) {
    try {
      const requireFromParent = createRequire(parentPackagePath);
      const entryPath = requireFromParent.resolve(moduleName);
      // require.resolve 命中 Node 内置模块时返回 "buffer" 这类非绝对路径
      // （兜底：即使调用方漏掉 isBuiltin 门禁，也不能沿 "." 从 cwd 向上找到仓库根）。
      if (isAbsolute(entryPath)) {
        const runtimePackage = findPackageRoot(entryPath, moduleName);
        if (runtimePackage) {
          return runtimePackage;
        }
      }
    } catch {
      // 父包相对解析失败时，继续走 workspace lookup roots 兜底。
    }
  }

  for (const lookupRoot of moduleLookupRoots) {
    const packageJsonPath = resolve(lookupRoot, "node_modules", moduleName, "package.json");
    if (!existsSync(packageJsonPath)) {
      continue;
    }

    const packageJson = readPackageJson(packageJsonPath);
    // 目录名和包名不一致时不能冒充目标模块，否则会把错误内容复制进 app.asar。
    if (packageJson?.name !== moduleName) {
      continue;
    }

    return {
      packageJson,
      packageJsonPath,
      packageRoot: dirname(packageJsonPath),
    };
  }
  return null;
}

export function collectRuntimeModuleClosure(moduleNames, moduleLookupRoots) {
  return collectRuntimeModuleClosureEntries(moduleNames, moduleLookupRoots).map(
    (entry) => entry.moduleName,
  );
}

export function collectRuntimeModuleClosureEntries(moduleNames, moduleLookupRoots) {
  const collected = [];
  const visited = new Set();

  function visit(moduleName, optional = false, parentPackagePath = null) {
    if (visited.has(moduleName)) {
      return;
    }

    // Node 运行时始终优先解析内置模块（含 node: 前缀），npm 里的同名包（如 buffer）
    // 不会被实际加载；本项目运行时只有 Node，因此可以直接跳过。
    // 若不在这里拦截，require.resolve("buffer") 会返回非绝对路径 "buffer"，
    // 旧实现会沿 dirname(".") 从 cwd 找到仓库根 package.json，把整个仓库当成依赖
    // 复制进 app.asar。
    if (isBuiltin(moduleName)) {
      visited.add(moduleName);
      return;
    }

    const runtimePackage = readRuntimePackage(moduleLookupRoots, moduleName, parentPackagePath);
    if (!runtimePackage && optional) {
      return;
    }

    visited.add(moduleName);
    collected.push({
      moduleName,
      sourceModulePath: runtimePackage?.packageRoot ?? null,
      packageJsonPath: runtimePackage?.packageJsonPath ?? null,
    });

    if (!runtimePackage) {
      return;
    }

    const { packageJson, packageJsonPath } = runtimePackage;
    const dependencies = packageJson.dependencies ?? {};
    const optionalDependencies = packageJson.optionalDependencies ?? {};
    const dependencyEntries = [
      ...Object.keys(dependencies).map((dependencyName) => [dependencyName, false]),
      ...Object.keys(optionalDependencies).map((dependencyName) => [dependencyName, true]),
    ];

    for (const [dependencyName, isOptional] of dependencyEntries.sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      // 运行时外置包进了 app.asar 时，它的 hoisted 子依赖不会自动跟着进包。
      // 递归收集 dependencies，让打包注入和产物校验覆盖完整运行时解析链。
      // pnpm 多版本同名依赖下，不能每层都从固定 lookup roots 取第一个目录。
      // 例如 yazl 需要 buffer-crc32@1.x，而 desktop 测试依赖里还有 0.2.x；
      // 必须从父包 package.json 相对解析，才能复制到真实运行时会加载的版本。
      visit(dependencyName, isOptional, packageJsonPath);
    }
  }

  for (const moduleName of moduleNames) {
    visit(moduleName);
  }

  return collected;
}

import assert from "node:assert/strict";
import test from "node:test";
import type * as Monaco from "monaco-editor";
import type { IServiceAccessor } from "@zcode/services";
import type { FilesWorkspaceRef } from "../src/files-workbench/filesEditorTypes.js";
import {
  invalidateFilesMonacoTypescriptWorkspaceCache,
  syncFilesMonacoTypescriptWorkspace,
  type FilesMonacoTypescriptWorkspaceEntry,
} from "../src/files-workbench/filesMonacoTypescriptWorkspace.js";
import { filesMonacoTypescriptWorkspaceScope } from "../src/files-workbench/filesMonacoTypescriptPath.js";

interface FakeFile {
  content: string;
  type: "file";
}

function createFakeServices(files: Record<string, string>): {
  services: IServiceAccessor;
  updateFile: (path: string, content: string) => void;
} {
  const fileMap = new Map<string, FakeFile>(
    Object.entries(files).map(([path, content]) => [path, { content, type: "file" }]),
  );
  const directories = new Set<string>(["/"]);
  for (const path of fileMap.keys()) {
    const parts = path.split("/").filter(Boolean);
    let current = "";
    for (const part of parts.slice(0, -1)) {
      current += `/${part}`;
      directories.add(current);
    }
  }
  const fileService = {
    async stat({ path }: { path: string }) {
      const file = fileMap.get(path);
      if (file)
        return { path, type: "file" as const, size: new TextEncoder().encode(file.content).length };
      if (directories.has(path)) return { path, type: "directory" as const };
      throw new Error(`ENOENT: ${path}`);
    },
    async readdir({ path }: { path: string }) {
      if (!directories.has(path)) throw new Error(`ENOENT: ${path}`);
      const prefix = path === "/" ? "/" : `${path}/`;
      const entries = new Map<string, { name: string; path: string; type: "file" | "directory" }>();
      for (const filePath of fileMap.keys()) {
        if (!filePath.startsWith(prefix)) continue;
        const rest = filePath.slice(prefix.length);
        if (!rest) continue;
        const name = rest.split("/")[0]!;
        const entryPath = `${prefix}${name}`;
        entries.set(name, {
          name,
          path: entryPath,
          type: rest.includes("/") ? "directory" : "file",
        });
      }
      return [...entries.values()];
    },
    async readTextFile({ path, length }: { path: string; length?: number }) {
      const file = fileMap.get(path);
      if (!file) throw new Error(`ENOENT: ${path}`);
      const content = file.content.slice(0, length ?? file.content.length);
      return {
        path,
        content,
        offset: 0,
        bytesRead: new TextEncoder().encode(content).length,
        totalBytes: new TextEncoder().encode(file.content).length,
        truncated: content.length < file.content.length,
        isBinary: false,
      };
    },
  };
  return {
    services: { fileService } as unknown as IServiceAccessor,
    updateFile: (path, content) => fileMap.set(path, { content, type: "file" }),
  };
}

function createFakeMonaco() {
  const state = {
    tsOptions: {} as Record<string, unknown>,
    jsOptions: {} as Record<string, unknown>,
    tsExtraLibs: [] as Array<{ content: string; filePath: string }>,
    jsExtraLibs: [] as Array<{ content: string; filePath: string }>,
  };
  const fakeDefaults = (kind: "ts" | "js") => ({
    setCompilerOptions(options: Record<string, unknown>) {
      if (kind === "ts") state.tsOptions = options;
      else state.jsOptions = options;
    },
    setEagerModelSync() {},
    setExtraLibs(libs: Array<{ content: string; filePath: string }>) {
      if (kind === "ts") state.tsExtraLibs = libs;
      else state.jsExtraLibs = libs;
    },
  });
  const fakeMonaco = {
    Uri: {
      file(path: string) {
        return { toString: () => `file://${path}` };
      },
      parse(value: string) {
        return { toString: () => value };
      },
    },
    typescript: {
      ScriptTarget: { ESNext: 99 },
      ModuleKind: { ESNext: 99 },
      JsxEmit: { ReactJSX: 4 },
      typescriptDefaults: fakeDefaults("ts"),
      javascriptDefaults: fakeDefaults("js"),
    },
  } as unknown as typeof Monaco;
  return { monaco: fakeMonaco, state };
}

function workspaceFiles(
  aliasValue: string,
  packageName: string,
  packageValue: string,
): Record<string, string> {
  return {
    "/repo/tsconfig.base.json": JSON.stringify({
      compilerOptions: {
        baseUrl: ".",
        paths: { "@/*": ["src/*"] },
        allowJs: true,
      },
    }),
    "/repo/tsconfig.app.json": JSON.stringify({
      extends: "./tsconfig.base.json",
      compilerOptions: { moduleResolution: "Bundler" },
    }),
    "/repo/src/main.ts": `import { aliasValue } from "@/utils/alias";\nimport { packageValue } from "${packageName}";\nexport const result = aliasValue + packageValue;`,
    "/repo/src/utils/alias.ts": `export const aliasValue = "${aliasValue}";`,
    [`/repo/node_modules/${packageName}/package.json`]: JSON.stringify({ types: "index.d.ts" }),
    [`/repo/node_modules/${packageName}/index.d.ts`]: `export declare const packageValue: "${packageValue}";`,
  };
}

test("workspace sync loads relative path aliases and package declarations without mixing equal paths", async () => {
  const local: FilesWorkspaceRef = { workspacePath: "/repo", workspaceIdentity: "local-workspace" };
  const remote: FilesWorkspaceRef = {
    workspacePath: "/repo",
    workspaceIdentity: "remote-workspace",
    workspaceRemoteSessionId: "remote-session",
  };
  const localFileSystem = createFakeServices(
    workspaceFiles("LOCAL_ALIAS", "pkg-local", "LOCAL_PACKAGE"),
  );
  const remoteFileSystem = createFakeServices(
    workspaceFiles("REMOTE_ALIAS", "pkg-remote", "REMOTE_PACKAGE"),
  );
  const services = new Map<string, IServiceAccessor>([
    ["local-workspace", localFileSystem.services],
    ["remote-workspace", remoteFileSystem.services],
  ]);
  const entries: FilesMonacoTypescriptWorkspaceEntry[] = [
    {
      bufferId: "file:local-workspace:/repo/src/main.ts",
      path: "/repo/src/main.ts",
      text: workspaceFiles("LOCAL_ALIAS", "pkg-local", "LOCAL_PACKAGE")["/repo/src/main.ts"]!,
      workspace: local,
    },
    {
      bufferId: "file:remote-workspace:/repo/src/main.ts",
      path: "/repo/src/main.ts",
      text: workspaceFiles("REMOTE_ALIAS", "pkg-remote", "REMOTE_PACKAGE")["/repo/src/main.ts"]!,
      workspace: remote,
    },
  ];
  const { monaco, state } = createFakeMonaco();

  await syncFilesMonacoTypescriptWorkspace({
    monaco,
    entries,
    activeWorkspace: local,
    resolveServices: (workspace) => services.get(workspace.workspaceIdentity!)!,
  });

  const libs = state.tsExtraLibs;
  const localAlias = libs.find(
    (lib) =>
      lib.filePath.includes("/repo/src/utils/alias.ts") && lib.content.includes("LOCAL_ALIAS"),
  );
  const remoteAlias = libs.find(
    (lib) =>
      lib.filePath.includes("/repo/src/utils/alias.ts") && lib.content.includes("REMOTE_ALIAS"),
  );
  const localPackage = libs.find((lib) =>
    lib.filePath.includes("/repo/node_modules/pkg-local/index.d.ts"),
  );
  const remotePackage = libs.find((lib) =>
    lib.filePath.includes("/repo/node_modules/pkg-remote/index.d.ts"),
  );

  assert.ok(localAlias, "local path alias declaration is injected");
  assert.ok(remoteAlias, "remote path alias declaration is injected");
  assert.ok(localPackage, "local package declaration is injected");
  assert.ok(remotePackage, "remote package declaration is injected");
  assert.notEqual(
    localAlias.filePath,
    remoteAlias.filePath,
    "workspace paths must be virtualized separately",
  );
  assert.ok(String(state.tsOptions.baseUrl).includes("__ycode_workspaces__"));
  assert.equal(state.tsExtraLibs.length, state.jsExtraLibs.length);

  localFileSystem.updateFile(
    "/repo/src/utils/alias.ts",
    'export const aliasValue = "UPDATED_ALIAS";',
  );
  invalidateFilesMonacoTypescriptWorkspaceCache(
    filesMonacoTypescriptWorkspaceScope(local),
    "/repo/src/utils/alias.ts",
  );
  await syncFilesMonacoTypescriptWorkspace({
    monaco,
    entries,
    activeWorkspace: local,
    resolveServices: (workspace) => services.get(workspace.workspaceIdentity!)!,
  });
  assert.ok(
    state.tsExtraLibs.some(
      (lib) => lib.filePath === localAlias.filePath && lib.content.includes("UPDATED_ALIAS"),
    ),
    "filesystem changes invalidate cached local declaration content",
  );
});

test("a stalled remote file service cannot block subsequent TypeScript syncs", async () => {
  const workspace: FilesWorkspaceRef = {
    workspacePath: "/blocked",
    workspaceIdentity: "blocked-test-workspace",
    workspaceRemoteSessionId: "blocked-remote",
  };
  const { monaco, state } = createFakeMonaco();
  const never = new Promise<never>(() => undefined);
  const stalledServices = {
    fileService: { stat: () => never },
  } as unknown as IServiceAccessor;
  const entry: FilesMonacoTypescriptWorkspaceEntry = {
    workspace,
    bufferId: "blocked-index",
    path: "/blocked/index.ts",
    text: "export const x: number = 1;",
  };
  const before = Date.now();
  await syncFilesMonacoTypescriptWorkspace({
    monaco,
    entries: [entry],
    activeWorkspace: workspace,
    resolveServices: () => stalledServices,
    maxDurationMs: 25,
  });
  assert.ok(Date.now() - before < 1000, "stalled workspace should be bounded");

  const healthy = createFakeServices({ "/blocked/index.ts": entry.text });
  await syncFilesMonacoTypescriptWorkspace({
    monaco,
    entries: [entry],
    activeWorkspace: workspace,
    resolveServices: () => healthy.services,
    maxDurationMs: 2000,
  });
  assert.ok(String(state.tsOptions.moduleResolution), "next sync must make forward progress");
});

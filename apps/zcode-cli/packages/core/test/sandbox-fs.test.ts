import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import * as nodeFs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NodeFileSystemAdapter } from "../../adapters/src/fs/index.js";
import type { CollaborationMode, SessionId } from "@zcode/contracts";
import { SandboxInstance } from "../src/sandbox/instance.js";
import { resolveWorkspacePath } from "../src/tool/path-policy.js";
import {
  SANDBOX_FS_CALLBACK_METHODS,
  SANDBOX_FS_PROMISE_IMPLEMENTED,
  SANDBOX_FS_SYNC_METHODS,
  SANDBOX_FS_UNSUPPORTED_PROMISE,
  SANDBOX_FS_UNSUPPORTED_ROOT,
  SANDBOX_FS_WRITE_METHODS,
} from "../src/sandbox/fs-names.js";

const SESSION = "sess_test_sandbox_fs" as SessionId;

async function evalText(instance: SandboxInstance, code: string): Promise<string> {
  const outcome = await instance.eval(code);
  assert.equal(
    outcome.result.kind,
    "completed",
    outcome.result.kind === "failed" ? `${outcome.result.error.code}: ${outcome.result.error.message}` : "",
  );
  assert.equal(outcome.alive, true);
  if (outcome.result.kind !== "completed") return "";
  return outcome.result.returnText ?? "";
}

async function withLiveFs(input: {
  mode: CollaborationMode;
  setup?: (root: string) => Promise<void>;
  run: (instance: SandboxInstance, root: string, host: { mode: CollaborationMode }) => Promise<void>;
}): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "zcode-sandbox-fs-"));
  await input.setup?.(root);
  const host = { mode: input.mode };
  const port = new NodeFileSystemAdapter();
  const instance = await SandboxInstance.create(undefined, {
    sessionId: SESSION,
    resolve: () => ({
      sessionId: SESSION,
      fileSystemPort: port,
      mode: host.mode,
      workingDirectory: root,
      workspaceRoot: root,
    }),
  });
  try {
    await input.run(instance, root, host);
  } finally {
    instance.dispose();
  }
}

test("只读档拒绝的写方法都在真做清单里", () => {
  for (const name of SANDBOX_FS_WRITE_METHODS) {
    assert.ok((SANDBOX_FS_PROMISE_IMPLEMENTED as readonly string[]).includes(name), name);
  }
});

test("路径解析与 Read 工具一致：同一输入落到同一绝对路径", () => {
  const root = join(tmpdir(), "zcode-sandbox-fs-ws");
  assert.equal(
    resolveWorkspacePath({
      inputPath: "../secret.txt",
      workingDirectory: root,
      workspaceRoot: root,
      operation: "read",
    }),
    join(tmpdir(), "secret.txt"),
  );
});

test("Agent 档 readFile 内容挂全局后第二次 eval 仍在", async () => {
  await withLiveFs({
    mode: "yolo",
    setup: async (root) => {
      await writeFile(join(root, "note.txt"), "hello-live");
    },
    run: async (instance) => {
      assert.equal(
        await evalText(
          instance,
          `globalThis.doc = await fs.promises.readFile("note.txt", "utf8"); return doc;`,
        ),
        "hello-live",
      );
      assert.equal(await evalText(instance, "return doc;"), "hello-live");
    },
  });
});

test("Ask 档 writeFile 失败磁盘不变；切到 Agent 立即能写", async () => {
  await withLiveFs({
    mode: "readonly",
    run: async (instance, root, host) => {
      assert.equal(
        await evalText(
          instance,
          `try { await fs.promises.writeFile("out.txt", "nope"); return "wrote"; } catch (e) { return e.code; }`,
        ),
        "SANDBOX_FS_READONLY",
      );
      await assert.rejects(() => readFile(join(root, "out.txt")));
      host.mode = "yolo";
      assert.equal(
        await evalText(instance, `await fs.promises.writeFile("out.txt", "yes"); return "wrote";`),
        "wrote",
      );
      assert.equal(await readFile(join(root, "out.txt"), "utf8"), "yes");
    },
  });
});

test("工作区外可读：../ 与指向工作区外的符号链接读到文件", async () => {
  const parent = await mkdtemp(join(tmpdir(), "zcode-sandbox-fs-parent-"));
  const root = join(parent, "ws");
  const outside = join(parent, "secret.txt");
  await mkdir(root);
  await writeFile(outside, "secret");
  await writeFile(join(root, "ok.txt"), "ok");
  await symlink(outside, join(root, "escape"));
  const port = new NodeFileSystemAdapter();
  const instance = await SandboxInstance.create(undefined, {
    sessionId: SESSION,
    resolve: () => ({
      sessionId: SESSION,
      fileSystemPort: port,
      mode: "yolo",
      workingDirectory: root,
      workspaceRoot: root,
    }),
  });
  try {
    assert.equal(
      await evalText(
        instance,
        `return await fs.promises.readFile("../secret.txt", "utf8");`,
      ),
      "secret",
    );
    assert.equal(
      await evalText(
        instance,
        `return await fs.promises.readFile("escape", "utf8");`,
      ),
      "secret",
    );
    assert.equal(await evalText(instance, `return await fs.promises.readFile("ok.txt", "utf8");`), "ok");
  } finally {
    instance.dispose();
  }
});

test("绝对路径指向工作区外可读：os.tmpdir 下的文件（自清理）", async () => {
  const outsideDir = await mkdtemp(join(tmpdir(), "zcode-sandbox-fs-abs-"));
  const outside = join(outsideDir, "abs-secret.txt");
  await writeFile(outside, "abs-secret");
  const root = await mkdtemp(join(tmpdir(), "zcode-sandbox-fs-ws-"));
  const port = new NodeFileSystemAdapter();
  const instance = await SandboxInstance.create(undefined, {
    sessionId: SESSION,
    resolve: () => ({
      sessionId: SESSION,
      fileSystemPort: port,
      mode: "yolo",
      workingDirectory: root,
      workspaceRoot: root,
    }),
  });
  try {
    assert.equal(
      await evalText(
        instance,
        `return await fs.promises.readFile(${JSON.stringify(outside)}, "utf8");`,
      ),
      "abs-secret",
    );
  } finally {
    instance.dispose();
    await rm(outsideDir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("同步拒绝名单覆盖当前 Node 导出的所有同步 FS I/O 方法", () => {
  const exposedSyncMethods = Object.keys(nodeFs).filter((name) => name.endsWith("Sync"));
  for (const name of exposedSyncMethods) assert.ok((SANDBOX_FS_SYNC_METHODS as readonly string[]).includes(name), name);
});

test("所有 Node 同步 FS 导出和别名均以统一错误拒绝", async () => {
  await withLiveFs({
    mode: "yolo",
    run: async (instance) => {
      for (const name of SANDBOX_FS_SYNC_METHODS) {
        const result = await evalText(
          instance,
          `try { require("node:fs")[${JSON.stringify(name)}]("a.txt"); return "ok"; } catch (e) { return e.code + ":" + e.message; }`,
        );
        assert.match(result, /^SANDBOX_FS_SYNC:JSVM_FS_SYNC_DISABLED: Synchronous filesystem APIs are not supported/);
      }
      assert.equal(
        await evalText(instance, `const { readFileSync: read } = require("fs"); try { read("x"); } catch (e) { return e.code; }`),
        "SANDBOX_FS_SYNC",
      );
      assert.equal(await evalText(instance, `return String(fs.constants.F_OK);`), "0");
    },
  });
});

test("VM dispose 后 callback FS 结算作废", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-sandbox-fs-dispose-"));
  const instance = await SandboxInstance.create(undefined, {
    sessionId: SESSION,
    resolve: () => ({
      sessionId: SESSION,
      fileSystemPort: new NodeFileSystemAdapter(),
      mode: "yolo",
      workingDirectory: root,
      workspaceRoot: root,
    }),
  });
  try {
    assert.equal(
      await evalText(
        instance,
        `globalThis.callbackFinished = false; fs.readFile("missing.txt", () => { callbackFinished = true; }); return "scheduled";`,
      ),
      "scheduled",
    );
  } finally {
    instance.dispose();
    await rm(root, { recursive: true, force: true });
  }
  await new Promise((resolve) => setImmediate(resolve));
});

test("callback FS 写入仍执行 Ask/Plan 权限检查", async () => {
  await withLiveFs({
    mode: "readonly",
    run: async (instance, root) => {
      assert.equal(
        await evalText(
          instance,
          `return await new Promise((resolve) => fs.writeFile("blocked.txt", "no", (error) => resolve(error.code)));`,
        ),
        "SANDBOX_FS_READONLY",
      );
      await assert.rejects(() => readFile(join(root, "blocked.txt")));
    },
  });
});

test("未实现接口明确拒绝；readFile callback 保留原生回调形态", async () => {
  await withLiveFs({
    mode: "yolo",
    setup: async (root) => {
      await writeFile(join(root, "a.txt"), "callback-data");
    },
    run: async (instance) => {
      assert.equal(
        await evalText(
          instance,
          `try { await fs.promises.open("a.txt"); return "ok"; } catch (e) { return e.code; }`,
        ),
        "SANDBOX_FS_UNSUPPORTED",
      );
      assert.equal(
        await evalText(instance, `try { fs.watch("a.txt"); return "ok"; } catch (e) { return e.code; }`),
        "SANDBOX_FS_CALLBACK",
      );
      assert.equal(
        await evalText(
          instance,
          `return await new Promise((resolve, reject) => { const result = fs.readFile("a.txt", "utf8", (error, data) => error ? reject(error) : resolve(data)); if (result !== undefined) reject(new Error("callback API returned a value")); });`,
        ),
        "callback-data",
      );
      assert.equal(
        await evalText(
          instance,
          `return await new Promise((resolve) => fs.readFile("missing.txt", "utf8", (error, data) => resolve(error.code + ":" + String(data))));`,
        ),
        "ENOENT:undefined",
      );
      assert.equal(
        await evalText(instance, `const read = require("node:fs").readFileSync; try { read("a.txt"); } catch (e) { return e.code; }`),
        "SANDBOX_FS_SYNC",
      );
      assert.equal(
        await evalText(instance, `const fsAlias = await import("node:fs"); try { fsAlias.readFileSync("x"); } catch (e) { return e.code; }`),
        "SANDBOX_FS_SYNC",
      );
    },
  });
});

test("require 别名与 fs.promises 同一对象；path 四件套", async () => {
  await withLiveFs({
    mode: "yolo",
    run: async (instance) => {
      assert.equal(
        await evalText(
          instance,
          `return String(require("fs/promises") === fs.promises) + "," + String(require("node:fs") === fs) + "," + String(require("path") === path);`,
        ),
        "true,true,true",
      );
      assert.equal(await evalText(instance, `return path.join("a", "b");`), join("a", "b"));
      assert.equal(await evalText(instance, `return path.basename("/x/y.z");`), "y.z");
      assert.equal(await evalText(instance, `return path.dirname("/x/y.z");`), "/x");
      assert.equal(await evalText(instance, `return path.extname("y.z");`), ".z");
      assert.equal(
        await evalText(instance, `try { require("os"); return "ok"; } catch (e) { return e.code; }`),
        "SANDBOX_NO_MODULE",
      );
    },
  });
});

test("真做：utf8 / Uint8Array / readdir / mkdir / append / 只读档 mkdir 拒绝", async () => {
  await withLiveFs({
    mode: "yolo",
    setup: async (root) => {
      await writeFile(join(root, "bin.dat"), "abc");
    },
    run: async (instance, root) => {
      assert.equal(
        await evalText(
          instance,
          `const buf = await fs.promises.readFile("bin.dat"); return (buf instanceof Uint8Array) + ":" + buf.length;`,
        ),
        "true:3",
      );
      await evalText(instance, `await fs.promises.mkdir("sub"); await fs.promises.writeFile("sub/a.txt", "one");`);
      await evalText(instance, `await fs.promises.appendFile("sub/a.txt", "two");`);
      assert.equal(await readFile(join(root, "sub", "a.txt"), "utf8"), "onetwo");
      assert.equal(
        await evalText(
          instance,
          `const names = await fs.promises.readdir("sub"); const ents = await fs.promises.readdir("sub", { withFileTypes: true }); return names.join(",") + ":" + ents[0].isFile();`,
        ),
        "a.txt:true",
      );
    },
  });
});

test("方法名表：真做、同步、回调、未实现都挂着", async () => {
  await withLiveFs({
    mode: "yolo",
    run: async (instance) => {
      const names = [
        ...SANDBOX_FS_PROMISE_IMPLEMENTED.map((name) => `fs.promises.${name}`),
        ...SANDBOX_FS_SYNC_METHODS.map((name) => `fs.${name}`),
        ...SANDBOX_FS_CALLBACK_METHODS.map((name) => `fs.${name}`),
        ...SANDBOX_FS_UNSUPPORTED_ROOT.map((name) => `fs.${name}`),
        ...SANDBOX_FS_UNSUPPORTED_PROMISE.map((name) => `fs.promises.${name}`),
      ];
      const script = `return [${names.map((name) => `typeof ${name}`).join(", ")}].every(function (t) { return t === "function"; });`;
      assert.equal(await evalText(instance, script), "true");
    },
  });
});

test("ESM import / import() 与 require 同一对象；未知模块 SANDBOX_NO_MODULE", async () => {
  await withLiveFs({
    mode: "yolo",
    run: async (instance) => {
      assert.equal(
        await evalText(
          instance,
          `import fs from "fs";\nimport * as path from "path";\nreturn String(fs === require("fs")) + "," + String(path === require("path"));`,
        ),
        "true,true",
      );
      assert.equal(
        await evalText(
          instance,
          `import { promises as fsp } from "fs";\nreturn String(fsp === fs.promises);`,
        ),
        "true",
      );
      assert.equal(
        await evalText(instance, `const m = await import("fs");\nreturn String(m === fs);`),
        "true",
      );
      assert.equal(
        await evalText(
          instance,
          `try { await import("os"); return "ok"; } catch (e) { return e.code; }`,
        ),
        "SANDBOX_NO_MODULE",
      );
      const unknownStatic = await instance.eval(`import os from "os";\nreturn "ok";`);
      assert.equal(unknownStatic.result.kind, "failed");
      if (unknownStatic.result.kind === "failed") {
        assert.match(unknownStatic.result.error.message, /no Node module loader/);
        assert.equal(unknownStatic.result.error.message.includes("could not load module"), false);
      }
      const user = await instance.evalUser(`(await import("path")).join("a", "b")`);
      assert.equal(user.result.kind, "completed");
      if (user.result.kind === "completed") {
        assert.equal(user.result.returnText, join("a", "b"));
      }
    },
  });
});

test("缺文件 access 是 ENOENT", async () => {
  await withLiveFs({
    mode: "yolo",
    run: async (instance) => {
      assert.equal(
        await evalText(
          instance,
          `try { await fs.promises.access("missing.txt"); return "ok"; } catch (e) { return e.code; }`,
        ),
        "ENOENT",
      );
    },
  });
});

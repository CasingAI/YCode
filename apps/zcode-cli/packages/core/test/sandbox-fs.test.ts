import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import * as nodeFs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NodeFileSystemAdapter } from "../../adapters/src/fs/index.js";
import type { CollaborationMode, FileSystemPort, SessionId } from "@zcode/contracts";
import { SANDBOX_FS_READ_MAX_BYTES } from "../src/sandbox/constants.js";
import { SandboxInstance } from "../src/sandbox/instance.js";
import { SandboxInstanceTable } from "../src/sandbox/instance-table.js";
import { resolveWorkspacePath } from "../src/tool/path-policy.js";
import {
  SANDBOX_FS_CALLBACK_METHODS,
  SANDBOX_FS_PROMISE_IMPLEMENTED,
  SANDBOX_FS_SYNC_IMPLEMENTED,
  SANDBOX_FS_SYNC_METHODS,
  SANDBOX_FS_SYNC_UNSUPPORTED,
  SANDBOX_FS_UNSUPPORTED_PROMISE,
  SANDBOX_FS_UNSUPPORTED_ROOT,
  SANDBOX_FS_WRITE_METHODS,
} from "../src/sandbox/fs-names.js";

const SESSION = "sess_test_sandbox_fs" as SessionId;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function evalText(instance: SandboxInstance, code: string): Promise<string> {
  const outcome = await instance.eval(code);
  assert.equal(
    outcome.result.kind,
    "completed",
    outcome.result.kind === "failed"
      ? `${outcome.result.error.code}: ${outcome.result.error.message}`
      : "",
  );
  assert.equal(outcome.alive, true);
  if (outcome.result.kind !== "completed") return "";
  return outcome.result.returnText ?? "";
}

async function withLiveFs(input: {
  mode: CollaborationMode;
  setup?: (root: string) => Promise<void>;
  run: (
    instance: SandboxInstance,
    root: string,
    host: { mode: CollaborationMode },
  ) => Promise<void>;
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
    await rm(root, { recursive: true, force: true });
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
      await evalText(instance, `return await fs.promises.readFile("../secret.txt", "utf8");`),
      "secret",
    );
    assert.equal(
      await evalText(instance, `return await fs.promises.readFile("escape", "utf8");`),
      "secret",
    );
    assert.equal(
      await evalText(instance, `return await fs.promises.readFile("ok.txt", "utf8");`),
      "ok",
    );
  } finally {
    instance.dispose();
    await rm(parent, { recursive: true, force: true });
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

test("同步名单覆盖当前 Node 导出的所有同步 FS I/O 方法，且支持/不支持无交集", () => {
  const exposedSyncMethods = Object.keys(nodeFs).filter((name) => name.endsWith("Sync"));
  for (const name of exposedSyncMethods) {
    assert.ok((SANDBOX_FS_SYNC_METHODS as readonly string[]).includes(name), name);
  }
  for (const name of SANDBOX_FS_SYNC_IMPLEMENTED) {
    assert.equal(
      (SANDBOX_FS_SYNC_UNSUPPORTED as readonly string[]).includes(name),
      false,
      `${name} must not be both supported and unsupported`,
    );
  }
});

test("不支持的同步方法统一 SANDBOX_FS_UNSUPPORTED，已支持方法不再抛 SANDBOX_FS_SYNC", async () => {
  await withLiveFs({
    mode: "yolo",
    setup: async (root) => {
      await writeFile(join(root, "a.txt"), "a");
    },
    run: async (instance) => {
      for (const name of SANDBOX_FS_SYNC_UNSUPPORTED) {
        const result = await evalText(
          instance,
          `try { require("node:fs")[${JSON.stringify(name)}]("a.txt"); return "ok"; } catch (e) { return e.code; }`,
        );
        assert.equal(result, "SANDBOX_FS_UNSUPPORTED", name);
      }
      assert.equal(
        await evalText(
          instance,
          `try { require("node:fs").realpathSync.native("a.txt"); return "ok"; } catch (e) { return e.code; }`,
        ),
        "SANDBOX_FS_UNSUPPORTED",
      );
      assert.equal(
        await evalText(
          instance,
          `try { require("node:fs").readFileSync("missing.txt"); } catch (e) { return e.code + ":" + String(e.code === "SANDBOX_FS_SYNC"); }`,
        ),
        "ENOENT:false",
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
        await evalText(
          instance,
          `try { fs.watch("a.txt"); return "ok"; } catch (e) { return e.code; }`,
        ),
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
        await evalText(
          instance,
          `const read = require("node:fs").readFileSync; return read("a.txt", "utf8");`,
        ),
        "callback-data",
      );
      assert.equal(
        await evalText(
          instance,
          `const fsAlias = await import("node:fs"); return fsAlias.readFileSync("a.txt", "utf8");`,
        ),
        "callback-data",
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
        await evalText(
          instance,
          `try { require("os"); return "ok"; } catch (e) { return e.code; }`,
        ),
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
      await evalText(
        instance,
        `await fs.promises.mkdir("sub"); await fs.promises.writeFile("sub/a.txt", "one");`,
      );
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

// -----------------------------------------------
// 同步 FS（阶段2）：读 / 写 / 边界 / 错误码
// -----------------------------------------------

test("同步读：utf8、二进制、cwd 解析、ENOENT / EINVAL / 不支持选项", async () => {
  await withLiveFs({
    mode: "yolo",
    setup: async (root) => {
      await writeFile(join(root, "note.txt"), "hello-sync");
      await writeFile(join(root, "bin.dat"), new Uint8Array([104, 105, 0, 255]));
      await mkdir(join(root, "sub"));
    },
    run: async (instance) => {
      const result = await evalText(
        instance,
        `
        const utf8 = fs.readFileSync("note.txt", "utf8");
        const bytes = fs.readFileSync("bin.dat");
        const nested = fs.readFileSync("sub/../note.txt", "utf8");
        let missing = "";
        try { fs.readFileSync("missing.txt"); } catch (e) { missing = e.code; }
        let empty = "";
        try { fs.readFileSync(""); } catch (e) { empty = e.code; }
        let bigint = "";
        try { fs.statSync("note.txt", { bigint: true }); } catch (e) { bigint = e.code; }
        let recursive = "";
        try { fs.readdirSync(".", { recursive: true }); } catch (e) { recursive = e.code; }
        return [
          utf8,
          bytes instanceof Uint8Array,
          bytes.length,
          bytes[0],
          nested,
          String(typeof Buffer),
          missing,
          empty,
          bigint,
          recursive,
        ].join("|");
        `,
      );
      assert.equal(
        result,
        "hello-sync|true|4|104|hello-sync|undefined|ENOENT|EINVAL|EINVAL|SANDBOX_FS_UNSUPPORTED",
      );
    },
  });
});

test("同步写 / 追加 / mkdir / readdir / stat / lstat / copy / rename / unlink / rmdir / rm", async () => {
  await withLiveFs({
    mode: "yolo",
    run: async (instance, root) => {
      const result = await evalText(
        instance,
        `
        fs.writeFileSync("out.txt", "one");
        fs.appendFileSync("out.txt", "two");
        fs.writeFileSync("b.bin", new Uint8Array([9, 8, 7]));
        fs.mkdirSync("d");
        fs.mkdirSync("d/nested", { recursive: true });
        const names = fs.readdirSync("d").sort();
        const dirents = fs.readdirSync("d", { withFileTypes: true });
        const stat = fs.statSync("out.txt");
        const lstat = fs.lstatSync("out.txt");
        fs.copyFileSync("out.txt", "copy.txt");
        fs.renameSync("copy.txt", "renamed.txt");
        let accessOk = "ok";
        try { fs.accessSync("renamed.txt"); } catch (e) { accessOk = e.code; }
        let accessMissing = "ok";
        try { fs.accessSync("nope.txt"); } catch (e) { accessMissing = e.code; }
        fs.unlinkSync("renamed.txt");
        fs.rmdirSync("d/nested");
        fs.rmSync("d", { recursive: true, force: true });
        fs.rmSync("gone", { force: true });
        return [
          names.join(","),
          dirents[0].isDirectory(),
          stat.isFile(),
          stat.size,
          lstat.isFile(),
          accessOk,
          accessMissing,
        ].join("|");
        `,
      );
      assert.equal(result, "nested|true|true|6|true|ok|ENOENT");
      assert.equal(await readFile(join(root, "out.txt"), "utf8"), "onetwo");
      const binary = await readFile(join(root, "b.bin"));
      assert.deepEqual([...binary], [9, 8, 7]);
      await assert.rejects(() => readFile(join(root, "renamed.txt")));
      await assert.rejects(() => readFile(join(root, "d")));
    },
  });
});

test("existsSync 返回 boolean 且缺失路径不抛；不是 accessSync 的别名", async () => {
  await withLiveFs({
    mode: "yolo",
    setup: async (root) => {
      await writeFile(join(root, "note.txt"), "x");
      await mkdir(join(root, "dir"));
    },
    run: async (instance) => {
      assert.equal(
        await evalText(
          instance,
          `return [
            fs.existsSync("note.txt"),
            typeof fs.existsSync("missing.txt"),
            fs.existsSync("missing.txt"),
            fs.existsSync("dir"),
            fs.existsSync(""),
          ].join("|");`,
        ),
        "true|boolean|false|true|false",
      );
      assert.equal(
        await evalText(
          instance,
          `try { fs.accessSync("missing.txt"); return "ok"; } catch (e) { return e.code; }`,
        ),
        "ENOENT",
      );
    },
  });
});

test("realpathSync 返回端口解析的真实路径；native 明确拒绝", async () => {
  await withLiveFs({
    mode: "yolo",
    setup: async (root) => {
      await writeFile(join(root, "note.txt"), "x");
      await mkdir(join(root, "sub"));
    },
    run: async (instance, root) => {
      const expectedFile = await realpath(join(root, "note.txt"));
      const expectedSub = await realpath(join(root, "sub"));
      assert.equal(
        await evalText(
          instance,
          `return [fs.realpathSync("note.txt"), fs.realpathSync("sub")].join("|");`,
        ),
        `${expectedFile}|${expectedSub}`,
      );
      assert.equal(
        await evalText(
          instance,
          `try { fs.realpathSync.native("note.txt"); return "ok"; } catch (e) { return e.code; }`,
        ),
        "SANDBOX_FS_UNSUPPORTED",
      );
    },
  });
});

test("同步方法不静默忽略 flag / mode / fd 参数，失败时不落盘", async () => {
  await withLiveFs({
    mode: "yolo",
    setup: async (root) => {
      await writeFile(join(root, "note.txt"), "orig");
      await writeFile(join(root, "123"), "number-name");
    },
    run: async (instance) => {
      const result = await evalText(
        instance,
        `
        function code(fn) {
          try { fn(); return "ok"; } catch (e) { return e.code; }
        }
        return [
          code(() => fs.writeFileSync("note.txt", "changed", { flag: "wx" })),
          code(() => fs.writeFileSync("note.txt", "changed", { mode: 384 })),
          code(() => fs.appendFileSync("note.txt", "x", { flag: "a" })),
          code(() => fs.copyFileSync("note.txt", "copy.txt", 1)),
          code(() => fs.accessSync("note.txt", fs.constants.W_OK)),
          code(() => fs.mkdirSync("mode-dir", { mode: 448 })),
          code(() => fs.rmSync("note.txt", { maxRetries: 1 })),
          code(() => fs.readFileSync("note.txt", { flag: "r" })),
          code(() => fs.readFileSync(123)),
          fs.readFileSync("note.txt", "utf8"),
          fs.existsSync("copy.txt"),
          fs.existsSync("mode-dir"),
        ].join("|");
        `,
      );
      assert.equal(
        result,
        "EINVAL|EINVAL|EINVAL|EINVAL|EINVAL|EINVAL|EINVAL|EINVAL|EINVAL|orig|false|false",
      );
    },
  });
});

test("同步编码边界：只接受 utf8；buffer 与未知 encoding 明确拒绝", async () => {
  await withLiveFs({
    mode: "yolo",
    setup: async (root) => {
      await writeFile(join(root, "note.txt"), "hello-sync");
    },
    run: async (instance) => {
      const result = await evalText(
        instance,
        `
        function code(fn) {
          try { fn(); return "ok"; } catch (e) { return e.code; }
        }
        const real = fs.realpathSync("note.txt");
        return [
          fs.readFileSync("note.txt", "utf8"),
          fs.readFileSync("note.txt") instanceof Uint8Array,
          fs.readFileSync("note.txt", "utf-8"),
          code(() => fs.readFileSync("note.txt", "latin1")),
          code(() => fs.readFileSync("note.txt", { encoding: "buffer" })),
          code(() => fs.readFileSync("note.txt", "buffer")),
          code(() => fs.readFileSync("note.txt", { encoding: "latin1" })),
          code(() => fs.realpathSync("note.txt", "buffer")),
          code(() => fs.realpathSync("note.txt", { encoding: "buffer" })),
          code(() => fs.realpathSync("note.txt", "latin1")),
          fs.realpathSync("note.txt", "utf8") === real,
          code(() => fs.writeFileSync("enc.txt", "x", { encoding: "latin1" })),
          fs.existsSync("enc.txt"),
          code(() => fs.writeFileSync("flag.txt", "x", { flag: "w" })),
          fs.existsSync("flag.txt"),
        ].join("|");
        `,
      );
      assert.equal(
        result,
        [
          "hello-sync",
          "true",
          "hello-sync",
          "EINVAL",
          "SANDBOX_FS_UNSUPPORTED",
          "SANDBOX_FS_UNSUPPORTED",
          "EINVAL",
          "SANDBOX_FS_UNSUPPORTED",
          "SANDBOX_FS_UNSUPPORTED",
          "EINVAL",
          "true",
          "EINVAL",
          "false",
          "EINVAL",
          "false",
        ].join("|"),
      );
    },
  });
});

test("Ask/Plan 档同步写先于参数拒绝返回 SANDBOX_FS_READONLY，读仍放行", async () => {
  await withLiveFs({
    mode: "readonly",
    setup: async (root) => {
      await writeFile(join(root, "note.txt"), "orig");
    },
    run: async (instance) => {
      const result = await evalText(
        instance,
        `
        function code(fn) {
          try { fn(); return "ok"; } catch (e) { return e.code; }
        }
        return [
          code(() => fs.writeFileSync("w.txt", "x", { flag: "wx" })),
          code(() => fs.copyFileSync("note.txt", "copy.txt", 1)),
          code(() => fs.mkdirSync("d", { mode: 448 })),
          code(() => fs.rmSync("note.txt", { maxRetries: 3 })),
          fs.existsSync("w.txt"),
          fs.existsSync("copy.txt"),
          fs.existsSync("d"),
          fs.readFileSync("note.txt", "utf8"),
          code(() => fs.readFileSync("note.txt", "latin1")),
        ].join("|");
        `,
      );
      assert.equal(
        result,
        "SANDBOX_FS_READONLY|SANDBOX_FS_READONLY|SANDBOX_FS_READONLY|SANDBOX_FS_READONLY|false|false|false|orig|EINVAL",
      );
    },
  });
});

test("Ask/Plan 档同步写先返回 SANDBOX_FS_READONLY，读放行；切 Agent 后可写", async () => {
  await withLiveFs({
    mode: "readonly",
    setup: async (root) => {
      await writeFile(join(root, "note.txt"), "readonly-ok");
    },
    run: async (instance, root, host) => {
      assert.equal(
        await evalText(instance, `return fs.readFileSync("note.txt", "utf8");`),
        "readonly-ok",
      );
      assert.equal(
        await evalText(
          instance,
          `try { fs.writeFileSync("blocked.txt", "no"); return "wrote"; } catch (e) { return e.code; }`,
        ),
        "SANDBOX_FS_READONLY",
      );
      assert.equal(
        await evalText(
          instance,
          `try { fs.mkdirSync("blocked-dir"); return "made"; } catch (e) { return e.code; }`,
        ),
        "SANDBOX_FS_READONLY",
      );
      await assert.rejects(() => readFile(join(root, "blocked.txt")));
      host.mode = "yolo";
      assert.equal(
        await evalText(
          instance,
          `fs.writeFileSync("blocked.txt", "yes"); return fs.readFileSync("blocked.txt", "utf8");`,
        ),
        "yes",
      );
      assert.equal(await readFile(join(root, "blocked.txt"), "utf8"), "yes");
    },
  });
});

test("同步读超过 16MiB 失败不截断", { timeout: 60_000 }, async () => {
  await withLiveFs({
    mode: "yolo",
    setup: async (root) => {
      await writeFile(join(root, "big.bin"), Buffer.alloc(SANDBOX_FS_READ_MAX_BYTES + 1024));
    },
    run: async (instance) => {
      assert.equal(
        await evalText(
          instance,
          `try { const b = fs.readFileSync("big.bin"); return "read:" + b.length; } catch (e) { return e.code; }`,
        ),
        "SANDBOX_FS_TOO_LARGE",
      );
    },
  });
});

test("连续同步调用不悬挂（同一 Worker 内循环 50 次）", { timeout: 30_000 }, async () => {
  await withLiveFs({
    mode: "yolo",
    setup: async (root) => {
      await writeFile(join(root, "note.txt"), "abcd");
    },
    run: async (instance) => {
      assert.equal(
        await evalText(
          instance,
          `let total = 0; for (let i = 0; i < 50; i++) { total += fs.readFileSync("note.txt", "utf8").length; } return String(total);`,
        ),
        "200",
      );
    },
  });
});

test("两会话同时同步读：各自 Worker 独立阻塞，互不影响", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-sandbox-fs-concurrent-"));
  await writeFile(join(root, "note.txt"), "concurrent");
  const port = new NodeFileSystemAdapter();
  const create = async (sessionId: SessionId) =>
    SandboxInstance.create(undefined, {
      sessionId,
      resolve: () => ({
        sessionId,
        fileSystemPort: port,
        mode: "yolo",
        workingDirectory: root,
        workspaceRoot: root,
      }),
    });
  const a = await create("sess_sync_concurrent_a" as SessionId);
  const b = await create("sess_sync_concurrent_b" as SessionId);
  try {
    const [first, second] = await Promise.all([
      evalText(a, `return fs.readFileSync("note.txt", "utf8");`),
      evalText(b, `return fs.readFileSync("note.txt", "utf8");`),
    ]);
    assert.equal(first, "concurrent");
    assert.equal(second, "concurrent");
  } finally {
    a.dispose();
    b.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("reset 期间在途同步请求失败，不会复活到新实例", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-sandbox-fs-reset-sync-"));
  await writeFile(join(root, "note.txt"), "reset-sync");
  const base = new NodeFileSystemAdapter();
  // 延迟端口用于把同步请求卡在 Atomics.wait 上，制造 reset 与在途请求重叠。
  const delayed = new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === "readBinaryFile") {
        return async (...args: Parameters<FileSystemPort["readBinaryFile"]>) => {
          await delay(400);
          return target.readBinaryFile(...args);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as FileSystemPort;
  const table = new SandboxInstanceTable();
  const sessionId = "sess_sync_reset" as SessionId;
  table.configureDeps({
    fileSystemPort: delayed,
    resolveFsHost: () => ({ mode: "yolo", workingDirectory: root, workspaceRoot: root }),
  });
  try {
    const pending = table.eval({
      sessionId,
      code: `return fs.readFileSync("note.txt", "utf8");`,
      timeoutMs: 10_000,
    });
    await delay(100);
    const resetStarted = Date.now();
    await table.reset(sessionId);
    assert.ok(Date.now() - resetStarted < 8_000, "reset waited on a blocked sync worker");
    const outcome = await pending;
    assert.equal(outcome.result.kind, "failed");

    const next = await table.eval({
      sessionId,
      code: `return fs.readFileSync("note.txt", "utf8");`,
      timeoutMs: 10_000,
    });
    assert.equal(next.result.kind, "completed");
    if (next.result.kind !== "completed") return;
    assert.equal(next.result.returnText, "reset-sync");
  } finally {
    table.disposeAll();
    await rm(root, { recursive: true, force: true });
  }
});

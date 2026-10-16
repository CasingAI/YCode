import assert from "node:assert/strict";
import { PassThrough, Readable } from "node:stream";
import test from "node:test";
import type { IRemoteBackend, StdioStream } from "../src/remote/backend.js";
import { REMOTE_BASE } from "../src/remote/deployShared.js";
import type { RemoteAssetInstaller } from "../src/remote/remoteAssetInstaller.js";
import { REMOTE_AGENT_SQLITE_WORKER_NAME } from "../src/remote/zcodeAgentBundleWrapper.js";
import { deployZCodeAgentRuntime } from "../src/remote/zcodeAgentDeploy.js";

const COMPONENT_SHA256 = "a".repeat(64);
const PLATFORM_ARCH = "linux-x64";
const REMOTE_PROVIDER_DIR = `${REMOTE_BASE}/agents/glm`;
const REMOTE_SQLITE_WORKER_PATH = `${REMOTE_PROVIDER_DIR}/${REMOTE_AGENT_SQLITE_WORKER_NAME}`;

function createSuccessfulStream(): StdioStream {
  return {
    stdin: new PassThrough(),
    stdout: Readable.from([]),
    stderr: Readable.from([]),
    onClose(listener) {
      queueMicrotask(() => listener(0));
      return { dispose() {} };
    },
  };
}

function createBackend(missingSqliteWorker: boolean): IRemoteBackend {
  return {
    async detect() {
      return { platform: "linux", arch: "x64" };
    },
    async upload() {},
    async exec() {
      return createSuccessfulStream();
    },
    async exists(remotePath) {
      return !(missingSqliteWorker && remotePath === REMOTE_SQLITE_WORKER_PATH);
    },
    async readFile() {
      return JSON.stringify({
        id: "glm",
        platformArch: PLATFORM_ARCH,
        sha256: COMPONENT_SHA256,
      });
    },
    dispose() {},
  };
}

function createInstaller(
  installedFiles: Array<{ sourceRelativePath: string; remotePath: string }>,
): RemoteAssetInstaller {
  return {
    mode: "local-download-upload",
    async resolveComponentSha256() {
      return COMPONENT_SHA256;
    },
    async installFile(params) {
      installedFiles.push({
        sourceRelativePath: params.sourceRelativePath,
        remotePath: params.remotePath,
      });
    },
    async installDirectory() {},
  };
}

async function deployWithRemoteSqliteWorker(missingSqliteWorker: boolean) {
  const installedFiles: Array<{ sourceRelativePath: string; remotePath: string }> = [];
  const originalRuntimeEnv = process.env.ZCODE_RUNTIME_ENV;
  process.env.ZCODE_RUNTIME_ENV = "production";
  try {
    await deployZCodeAgentRuntime(
      createBackend(missingSqliteWorker),
      { platform: "linux", arch: "x64" },
      {
        platformArch: PLATFORM_ARCH,
        installer: createInstaller(installedFiles),
      },
      { log() {}, logWarn() {} },
    );
  } finally {
    if (originalRuntimeEnv === undefined) delete process.env.ZCODE_RUNTIME_ENV;
    else process.env.ZCODE_RUNTIME_ENV = originalRuntimeEnv;
  }
  return installedFiles;
}

test("生产部署发现 SQLite worker 缺失时重新部署并安装该 worker", async () => {
  const installedFiles = await deployWithRemoteSqliteWorker(true);

  assert.ok(
    installedFiles.some(
      (asset) =>
        asset.sourceRelativePath === `glm/${PLATFORM_ARCH}/${REMOTE_AGENT_SQLITE_WORKER_NAME}` &&
        asset.remotePath === REMOTE_SQLITE_WORKER_PATH,
    ),
    "缺失的 SQLite worker 应从 GLM 组件安装到远端 Agent 目录",
  );
});

test("生产部署仅在 SQLite worker 等必需资产齐全时复用远端组件", async () => {
  const installedFiles = await deployWithRemoteSqliteWorker(false);

  assert.deepEqual(installedFiles, []);
});

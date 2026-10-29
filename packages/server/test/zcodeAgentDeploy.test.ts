import assert from "node:assert/strict";
import { PassThrough, Readable } from "node:stream";
import test from "node:test";
import type { IRemoteBackend, StdioStream } from "../src/remote/backend.js";
import { REMOTE_BASE } from "../src/remote/deployShared.js";
import type { RemoteAssetInstaller } from "../src/remote/remoteAssetInstaller.js";
import {
  REMOTE_AGENT_QUICKJS_WASM_NAME,
  REMOTE_AGENT_SANDBOX_WORKER_NAME,
  REMOTE_AGENT_SQLITE_WORKER_NAME,
} from "../src/remote/zcodeAgentBundleWrapper.js";
import { deployZCodeAgentRuntime } from "../src/remote/zcodeAgentDeploy.js";

const COMPONENT_SHA256 = "a".repeat(64);
const PLATFORM_ARCH = "linux-x64";
const REMOTE_PROVIDER_DIR = `${REMOTE_BASE}/agents/glm`;
const REMOTE_SQLITE_WORKER_PATH = `${REMOTE_PROVIDER_DIR}/${REMOTE_AGENT_SQLITE_WORKER_NAME}`;
const REMOTE_SANDBOX_WORKER_PATH = `${REMOTE_PROVIDER_DIR}/${REMOTE_AGENT_SANDBOX_WORKER_NAME}`;
const REMOTE_QUICKJS_WASM_PATH = `${REMOTE_PROVIDER_DIR}/${REMOTE_AGENT_QUICKJS_WASM_NAME}`;

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

function createBackend(missingRemotePath?: string): IRemoteBackend {
  return {
    async detect() {
      return { platform: "linux", arch: "x64" };
    },
    async upload() {},
    async exec() {
      return createSuccessfulStream();
    },
    async exists(remotePath) {
      return remotePath !== missingRemotePath;
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

async function deployWithRemoteAssetMissing(missingRemotePath?: string) {
  const installedFiles: Array<{ sourceRelativePath: string; remotePath: string }> = [];
  const originalRuntimeEnv = process.env.ZCODE_RUNTIME_ENV;
  process.env.ZCODE_RUNTIME_ENV = "production";
  try {
    await deployZCodeAgentRuntime(
      createBackend(missingRemotePath),
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

function assertInstalledAsset(
  installedFiles: Array<{ sourceRelativePath: string; remotePath: string }>,
  fileName: string,
  remotePath: string,
): void {
  assert.ok(
    installedFiles.some(
      (asset) =>
        asset.sourceRelativePath === `glm/${PLATFORM_ARCH}/${fileName}` &&
        asset.remotePath === remotePath,
    ),
    `缺失的 ${fileName} 应从 GLM 组件安装到远端 Agent 目录`,
  );
}

test("生产部署发现 SQLite worker 缺失时重新部署并安装全部 Agent 资产", async () => {
  const installedFiles = await deployWithRemoteAssetMissing(REMOTE_SQLITE_WORKER_PATH);

  assertInstalledAsset(installedFiles, REMOTE_AGENT_SQLITE_WORKER_NAME, REMOTE_SQLITE_WORKER_PATH);
  assertInstalledAsset(
    installedFiles,
    REMOTE_AGENT_SANDBOX_WORKER_NAME,
    REMOTE_SANDBOX_WORKER_PATH,
  );
  assertInstalledAsset(installedFiles, REMOTE_AGENT_QUICKJS_WASM_NAME, REMOTE_QUICKJS_WASM_PATH);
});

test("生产部署发现沙盒 Worker 缺失时重新部署", async () => {
  const installedFiles = await deployWithRemoteAssetMissing(REMOTE_SANDBOX_WORKER_PATH);

  assertInstalledAsset(
    installedFiles,
    REMOTE_AGENT_SANDBOX_WORKER_NAME,
    REMOTE_SANDBOX_WORKER_PATH,
  );
});

test("生产部署发现 QuickJS wasm 缺失时重新部署", async () => {
  const installedFiles = await deployWithRemoteAssetMissing(REMOTE_QUICKJS_WASM_PATH);

  assertInstalledAsset(installedFiles, REMOTE_AGENT_QUICKJS_WASM_NAME, REMOTE_QUICKJS_WASM_PATH);
});

test("生产部署仅在 SQLite worker 等必需资产齐全时复用远端组件", async () => {
  const installedFiles = await deployWithRemoteAssetMissing();

  assert.deepEqual(installedFiles, []);
});

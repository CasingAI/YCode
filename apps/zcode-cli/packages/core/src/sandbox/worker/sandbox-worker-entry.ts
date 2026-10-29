// ============================================================
// 常驻 QuickJS Worker 入口
// ============================================================
// 由主线程用 new Worker(...) 拉起；每会话一份，进程生命周期内常驻。
// 这里唯一的职责：读 workerData → 建唯一 VM → 收发消息。
// quickjs.wasm 走 workerData.wasmPath，不依赖 import.meta.url（CJS bundle 下无效）。

import { readFileSync } from "node:fs";
import { parentPort, workerData, type MessagePort } from "node:worker_threads";
import { sandboxHostErrorInfo } from "../host-args.js";
import {
  isSandboxWorkerInboundMessage,
  matchesSandboxWorkerIdentity,
  type SandboxWorkerInitData,
  type SandboxWorkerOutboundMessage,
} from "../worker-protocol.js";
import { SandboxWorkerHostBridge } from "./worker-host-bridge.js";
import { SandboxWorkerRuntime } from "./worker-runtime.js";

const port: MessagePort = parentPort as MessagePort;
if (!port) throw new Error("sandbox-worker must run inside worker_threads");

const init = workerData as SandboxWorkerInitData;
if (!init || typeof init.workerId !== "string" || typeof init.wasmPath !== "string") {
  throw new Error("sandbox-worker requires workerData.wasmPath");
}

function post(message: SandboxWorkerOutboundMessage): void {
  try {
    port.postMessage(message);
  } catch {
    // 主线程已 terminate：Worker 即将退出，不再重试。
  }
}

const identity = {
  workerId: init.workerId,
  generation: init.generation,
  sessionId: init.sessionId,
};

/**
 * 构建期插件会把 quickjs-wasi 的默认 wasm 定位改写成这个函数。
 * Worker 始终经 workerData.wasmPath 显式传 wasm，走到这里说明资产装配错了，
 * 必须显式失败而不是静默去读 import.meta（CJS bundle 下无效）。
 */
export function __zcodeQuickjsWasmUrl(): URL {
  throw new Error("sandbox-worker 必须通过 workerData.wasmPath 接收 quickjs.wasm");
}

const bridge = new SandboxWorkerHostBridge({ postMessage: post }, identity);
const runtime = new SandboxWorkerRuntime(
  identity,
  bridge,
  {
    console: (method, text) => post({ ...identity, type: "console", method, text }),
    localStorage: (change) => post({ ...identity, type: "local-storage", change }),
  },
  init.localStorageSnapshot,
);

port.on("message", (message: unknown) => {
  if (!isSandboxWorkerInboundMessage(message)) return;
  if (!matchesSandboxWorkerIdentity(message, identity)) return;
  switch (message.type) {
    case "eval":
      void runtime
        .eval(message.requestId, message.code, message.mode)
        .then(post)
        .catch((error: unknown) => {
          // runtime 已兜住 guest 侧错误；这里只剩宿主逻辑异常，如实回报。
          post({
            ...identity,
            type: "eval-result",
            requestId: message.requestId,
            alive: !runtime.isDisposed(),
            ok: false,
            error: sandboxHostErrorInfo(error),
            ...(runtime.heapBytes() === undefined ? {} : { heapBytes: runtime.heapBytes() as number }),
          });
        });
      return;
    case "host-result":
      bridge.handleResult(message);
      return;
    case "host-abort":
      bridge.handleAbort(message.requestId);
      return;
  }
});

void (async () => {
  try {
    const wasm = readFileSync(init.wasmPath);
    await runtime.start(wasm);
    post({ ...identity, type: "ready" });
  } catch (error) {
    post({ ...identity, type: "fatal", error: sandboxHostErrorInfo(error) });
    // 缺资产必须显式失败，绝不静默回退到主线程 VM。
    process.exitCode = 1;
    port.close();
  }
})();

port.on("close", () => {
  bridge.dispose();
  runtime.dispose();
});

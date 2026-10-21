import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PublicTunnelStatus } from "@zcode/services";
import {
  createPublicUrlController,
  type PublicTunnelStartTarget,
  type PublicTunnelStarter,
} from "../src/host/mobileRemoteControlPublicUrl.js";
import type { PublicTunnelHandle } from "../src/host/publicTunnelTypes.js";

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** 假的隧道句柄：记录 stop 被调用了几次，用来断言「迟到的隧道被回收」。 */
function createHandle(url: string): { handle: PublicTunnelHandle; stopCount: () => number } {
  let stopCount = 0;
  return {
    handle: {
      url,
      stop: async () => {
        stopCount += 1;
      },
    },
    stopCount: () => stopCount,
  };
}

/**
 * 可手动兑现的启动器。
 *
 * 隧道启动是异步的，"什么时候 ready"由网络决定；这里把它交给测试自己控制，
 * 才能复现"关闭时隧道还没起来"这类时序。
 */
function createStarter(): {
  starter: PublicTunnelStarter;
  calls: { params: { provider: string }; target: PublicTunnelStartTarget }[];
  resolveAt: (index: number, handle: PublicTunnelHandle) => void;
  rejectAt: (index: number, error: Error) => void;
} {
  const calls: { params: { provider: string }; target: PublicTunnelStartTarget }[] = [];
  const resolvers: ((handle: PublicTunnelHandle) => void)[] = [];
  const rejecters: ((error: Error) => void)[] = [];
  const starter: PublicTunnelStarter = (params, target) => {
    calls.push({ params, target });
    return new Promise<PublicTunnelHandle>((resolve, reject) => {
      resolvers.push(resolve);
      rejecters.push(reject);
    });
  };
  return {
    starter,
    calls,
    resolveAt: (index, handle) => resolvers[index]?.(handle),
    rejectAt: (index, error) => rejecters[index]?.(error),
  };
}

/** 远控正常运行时的现场。 */
const runningContext = () => ({
  disposed: false,
  running: true,
  port: 53211,
  token: "tok",
});

describe("公网链接控制器：创建与关闭不能交叉", () => {
  it("创建尚未完成时关闭：迟到的隧道被回收，不再发布 running", async () => {
    const { starter, calls, resolveAt } = createStarter();
    const statuses: (PublicTunnelStatus | undefined)[] = [];
    const controller = createPublicUrlController({
      resolveBinaryPath: () => undefined,
      logger: silentLogger,
      onStatus: (next) => statuses.push(next),
      startTunnel: starter,
    });

    const creating = controller.create({ provider: "cloudflare-quick" }, runningContext);
    assert.equal(calls.length, 1);
    assert.equal(controller.status?.state, "starting");

    // 用户在隧道起来之前就关闭了：这次创建被作废。
    const closing = controller.close();
    const late = createHandle("https://late.trycloudflare.com");
    resolveAt(0, late.handle);

    await creating;
    await closing;

    // 迟到的句柄被就地回收，不交给宿主。
    assert.equal(late.stopCount(), 1);
    assert.equal(controller.status, undefined);
    assert.deepEqual(
      statuses.map((item) => item?.state),
      ["starting", undefined],
    );
  });

  it("关闭要等在途创建收尾：关闭返回时隧道已经不在了", async () => {
    const { starter, resolveAt } = createStarter();
    const events: string[] = [];
    const late = createHandle("https://late.trycloudflare.com");
    const controller = createPublicUrlController({
      resolveBinaryPath: () => undefined,
      logger: silentLogger,
      onStatus: () => undefined,
      startTunnel: starter,
    });

    void controller.create({ provider: "cloudflare-quick" }, runningContext);
    const closing = controller.close();
    resolveAt(0, {
      url: late.handle.url,
      stop: async () => {
        events.push("stop");
        await late.handle.stop();
      },
    });
    await closing;
    events.push("closed");

    // 顺序必须是"先停隧道，后关闭返回"：关闭返回之后不允许还有隧道活着。
    assert.deepEqual(events, ["stop", "closed"]);
  });

  it("关闭过程中的新创建排在关闭之后，不与关闭交叉", async () => {
    const { starter, calls, resolveAt } = createStarter();
    const controller = createPublicUrlController({
      resolveBinaryPath: () => undefined,
      logger: silentLogger,
      onStatus: () => undefined,
      startTunnel: starter,
    });

    void controller.create({ provider: "cloudflare-quick" }, runningContext);
    const closing = controller.close();
    const second = controller.create({ provider: "cloudflare-quick" }, runningContext);
    // 关闭还没结束，第二次创建不能已经开跑。
    assert.equal(calls.length, 1);

    resolveAt(0, createHandle("https://first.trycloudflare.com").handle);
    await closing;
    // 关闭结束后这次创建才真正开始。
    assert.equal(calls.length, 2);
    resolveAt(1, createHandle("https://second.trycloudflare.com").handle);
    await second;
    assert.equal(controller.status?.state, "running");
  });

  it("排队中的创建读的是执行当时的远控状态，不会起一条指向死端口的隧道", async () => {
    const { starter, calls, resolveAt } = createStarter();
    const controller = createPublicUrlController({
      resolveBinaryPath: () => undefined,
      logger: silentLogger,
      onStatus: () => undefined,
      startTunnel: starter,
    });
    let running = true;
    const readContext = () => ({
      disposed: false,
      running,
      port: 53211,
      token: "tok",
    });

    void controller.create({ provider: "cloudflare-quick" }, readContext);
    const closing = controller.close();
    // 关闭期间远控停了。
    running = false;
    const second = controller.create({ provider: "cloudflare-quick" }, readContext);
    resolveAt(0, createHandle("https://first.trycloudflare.com").handle);
    await closing;
    await second;

    // 第二次创建执行时远控已经停了：直接报错，不再起隧道。
    assert.equal(calls.length, 1);
    assert.equal(controller.status?.state, "error");
    assert.match(controller.status?.error ?? "", /远程控制/);
  });

  it("过期隧道的意外退出回调不会动当前隧道", async () => {
    const { starter, calls, resolveAt } = createStarter();
    const controller = createPublicUrlController({
      resolveBinaryPath: () => undefined,
      logger: silentLogger,
      onStatus: () => undefined,
      startTunnel: starter,
    });

    const first = controller.create({ provider: "cloudflare-quick" }, runningContext);
    const staleExit = calls[0]?.target.onUnexpectedExit;
    resolveAt(0, createHandle("https://first.trycloudflare.com").handle);
    await first;
    await controller.close();

    const secondCreate = controller.create({ provider: "cloudflare-quick" }, runningContext);
    resolveAt(1, createHandle("https://second.trycloudflare.com").handle);
    await secondCreate;
    assert.equal(controller.status?.state, "running");

    // 上一条隧道这时才退出：它早就被作废了，不能把当前隧道打成 stopped。
    staleExit?.();
    assert.equal(controller.status?.state, "running");
    assert.match(controller.status?.url ?? "", /second/);
  });

  it("重复创建幂等：第二次沿用同一次创建，不另起隧道", async () => {
    const { starter, calls, resolveAt } = createStarter();
    const controller = createPublicUrlController({
      resolveBinaryPath: () => undefined,
      logger: silentLogger,
      onStatus: () => undefined,
      startTunnel: starter,
    });

    const first = controller.create({ provider: "cloudflare-quick" }, runningContext);
    const second = controller.create({ provider: "cloudflare-quick" }, runningContext);
    assert.equal(calls.length, 1);

    resolveAt(0, createHandle("https://only.trycloudflare.com").handle);
    await first;
    await second;
    assert.equal(calls.length, 1);
    assert.equal(controller.status?.state, "running");
  });

  it("隧道起不来时如实报 error，不影响别的状态", async () => {
    const { starter, rejectAt } = createStarter();
    const controller = createPublicUrlController({
      resolveBinaryPath: () => undefined,
      logger: silentLogger,
      onStatus: () => undefined,
      startTunnel: starter,
    });

    const creating = controller.create({ provider: "cloudflare-quick" }, runningContext);
    rejectAt(0, new Error("隧道进程已退出"));
    await creating;

    assert.equal(controller.status?.state, "error");
    assert.match(controller.status?.error ?? "", /隧道进程已退出/);
  });

  it("远控没开时直接报错，不去起隧道", async () => {
    const { starter, calls } = createStarter();
    const controller = createPublicUrlController({
      resolveBinaryPath: () => undefined,
      logger: silentLogger,
      onStatus: () => undefined,
      startTunnel: starter,
    });

    await controller.create({ provider: "cloudflare-quick" }, () => ({
      disposed: false,
      running: false,
      port: 53211,
      token: "tok",
    }));

    assert.equal(calls.length, 0);
    assert.equal(controller.status?.state, "error");
    assert.match(controller.status?.error ?? "", /远程控制/);
  });
});

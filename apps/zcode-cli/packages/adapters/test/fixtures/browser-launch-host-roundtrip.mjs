// 真实短命 Node 宿主往返测试夹具（docs/specs/process-priority.md）。
//
// 父进程分支调用 dist 中的 spawnBrowserLaunchHost；自 re-exec 的子进程分支只模拟宿主
// 的 ready/close/EOF 协议，不加载 Playwright、不启动浏览器。测试只创建和回收自己启动的
// 两个短命 Node 进程，不操作现有 YCode 或其它进程。
import process from "node:process";

const COMMAND = "__zcode-browser-host";

if (process.argv[2] === COMMAND) {
  const payload = JSON.parse(process.argv[3] ?? "{}");
  if (payload.args?.includes("close-stdout")) {
    // 真实 pipe 关闭回归：宿主在 ready 前销毁 stdout 并退出，父侧不得产生 unhandled。
    process.stdout.destroy();
    setTimeout(() => process.exit(0), 10);
  } else {
    process.stdout.write(
      `${JSON.stringify({ type: "ready", wsEndpoint: "ws://127.0.0.1:9/roundtrip" })}\n`,
    );

    let closed = false;
    const onData = (chunk) => {
      if (chunk.toString().includes('"close"')) shutdown();
    };
    const shutdown = () => {
      if (closed) return;
      closed = true;
      process.stdin.off("data", onData);
      process.stdin.pause();
      process.exit(0);
    };
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", onData);
    process.stdin.on("end", shutdown);
    process.stdin.resume();
  }
} else {
  const { spawnBrowserLaunchHost } = await import("../../dist/browser/launch-host.js");
  const host = await spawnBrowserLaunchHost(
    { args: [] },
    {
      closeTimeoutMs: 2_000,
      readyTimeoutMs: 10_000,
    },
  );
  const endpoint = host.wsEndpoint;
  await host.close();
  process.stdout.write(`${JSON.stringify({ endpoint, closed: true })}\n`);
}

// 独立 Electron fixture：证明 Main 被强制终止后 UtilityProcess 是否跟随退出。
// 无窗口、隔离 userData，不连接任何既有 YCode 实例。
// 同一文件按运行角色复用：utility 进程中存在 process.parentPort。
const fs = require("node:fs");

const childPidFile = process.env.ZCODE_UTILITY_CHILD_PID_FILE;
const reportFile = process.env.ZCODE_UTILITY_FOLLOW_EXIT_REPORT;
const userDataDir = process.env.ZCODE_UTILITY_FOLLOW_EXIT_USER_DATA;

if (process.parentPort && childPidFile) {
  // utility child：只报告自身 pid 并保持存活，等待 Main 死亡时是否被内核一并终止。
  // 不要在此分支 require("electron")：utility 进程只暴露受限 API，加载失败会让 child 立即退出。
  fs.writeFileSync(childPidFile, String(process.pid));
  setInterval(() => undefined, 1000);
} else {
  const { app, utilityProcess } = require("electron");
  if (userDataDir) app.setPath("userData", userDataDir);
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu");
  // 没有窗口时也保持 Main 存活，确保观察窗口内 Main 是唯一变量。
  app.on("window-all-closed", () => undefined);
  app.whenReady().then(() => {
    // 与 Host 的 fork 配置对齐：不显式指定 stdio，只保留 serviceName。
    utilityProcess.fork(__filename, [], {
      serviceName: "zcode-utility-follow-exit-fixture",
    });
    fs.writeFileSync(reportFile, JSON.stringify({ mainPid: process.pid }));
  });
}

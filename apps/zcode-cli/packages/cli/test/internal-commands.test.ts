// CLI 内部命令字面量必须与 adapters 公开常量一致
// （docs/specs/windows-bash-process-tree-stop.md）。
//
// SEA 单文件无法用 `--eval` 起启动器，只能 `process.execPath __zcode-job-launcher`；
// 入口按字面量分派，适配器按同一常量解析。任一侧改名都会让 Windows 启动闸门失效，
// 所以这里把两处绑定在一个断言里。
import assert from "node:assert/strict";
import test from "node:test";
import { JOB_LAUNCHER_COMMAND } from "@zcode/adapters/exec";
import { isBrowserHostInvocation, isJobLauncherInvocation } from "../src/internal-commands.js";

test("job launcher internal command matches the adapters constant", () => {
  assert.equal(isJobLauncherInvocation([JOB_LAUNCHER_COMMAND]), true);
  assert.equal(isJobLauncherInvocation([JOB_LAUNCHER_COMMAND, "extra"]), true);
  assert.equal(isJobLauncherInvocation([]), false);
  assert.equal(isJobLauncherInvocation(["tui"]), false);
  // 与浏览器宿主分派互不干扰。
  assert.equal(isBrowserHostInvocation([JOB_LAUNCHER_COMMAND]), false);
  assert.equal(isJobLauncherInvocation(["__zcode-browser-host", "{}"]), false);
});

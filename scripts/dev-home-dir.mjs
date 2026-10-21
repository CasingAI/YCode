import { homedir } from "node:os";

/**
 * dev 隔离目录的 home 根。
 *
 * 口径与 mise.toml 注入的 ZCODE_DEV_HOME_DIR 一致：
 * ZCODE_DEV_HOME_OVERRIDE（用户级环境变量）→ ZCODE_DEV_HOME_DIR（mise 链路下的唯一真值来源）
 * → HOME → USERPROFILE → os.homedir()。
 *
 * 之前这里只读 process.env.HOME：Windows 的 cmd / PowerShell 没有 HOME，
 * join("", ...) 会得到相对路径，CLI Proxy 的 dev 隔离目录直接掉进仓库工作目录。
 * 取值顺序见 docs/specs/desktop-prebuilt-start.md 的「dev home 目录只有一个口径」。
 */
export function resolveDevHomeDir(env = process.env) {
  return (
    env.ZCODE_DEV_HOME_OVERRIDE?.trim() ||
    env.ZCODE_DEV_HOME_DIR?.trim() ||
    env.HOME?.trim() ||
    env.USERPROFILE?.trim() ||
    homedir()
  );
}

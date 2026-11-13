import { ZCODE_BROWSER_HOST_COMMAND } from "@zcode/contracts";

/**
 * Linux CLI 受管浏览器的 idle 启动宿主入口。
 *
 * 只做字面量判断，不加载 Playwright/适配器；main.ts 需要先于 run/bootstrap 分派它。
 */
export function isBrowserHostInvocation(argv: readonly string[]): boolean {
  return argv[0] === ZCODE_BROWSER_HOST_COMMAND;
}

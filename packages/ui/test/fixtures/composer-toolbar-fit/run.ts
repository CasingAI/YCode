import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadChromium } from "../../helpers/chromiumFixture.js";

/**
 * Composer 工具栏 fit 的独立浏览器验证。
 *
 * 只使用测试自己的 Vite 构建、静态服务与无头 Chromium；不连接、不注入、
 * 不关闭、不重启正在运行的 YCode，也不下载浏览器。
 */

type Point = { left: number; right: number; top: number; bottom: number; width: number };

type Projection = {
  compact: Array<{ priority: string; compact: boolean }>;
  modelIcon: boolean;
  modelMaxWidth: string;
  providerCompact: boolean;
};

type Snapshot = Projection & {
  activeRole: string | null;
  firstFit: Projection | null;
  frameWidth: number;
  liveProbeCount: number;
  rootRect: Point;
  sendRect: Point;
  tooltipRect: Point;
};

type Probe = {
  clones: number;
  maxClonesPerFrame: number;
  roDisconnectCalls: number;
  roObserveCalls: number;
  writes: number;
};

export type Assertion = { detail?: unknown; name: string; ok: boolean };

export type RunResult = {
  assertions: Assertion[];
  consoleErrors: string[];
  pageErrors: string[];
  skipped: boolean;
  skipReason?: string;
};

const HERE = fileURLToPath(new URL(".", import.meta.url));

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function startStaticServer(root: string): Promise<ReturnType<typeof createServer>> {
  const server = createServer(async (request, response) => {
    try {
      const urlPath = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
      const relative = urlPath.replace(/^([/\\])+/, "");
      let filePath = join(root, relative);
      try {
        const info = await stat(filePath);
        if (info.isDirectory()) filePath = join(filePath, "index.html");
      } catch {
        if (extname(relative)) {
          response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
          response.end("not found");
          return;
        }
        filePath = join(root, "index.html");
      }
      const body = await readFile(filePath);
      response.writeHead(200, {
        "content-type": MIME[extname(filePath)] ?? "application/octet-stream",
        "cache-control": "no-store",
      });
      response.end(body);
    } catch (error) {
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end(String(error));
    }
  });
  return new Promise((resolveServer, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveServer(server));
  });
}

export async function main(): Promise<RunResult> {
  const result: RunResult = {
    assertions: [],
    consoleErrors: [],
    pageErrors: [],
    skipped: false,
  };
  const check = (name: string, ok: boolean, detail?: unknown): boolean => {
    result.assertions.push({ detail, name, ok });
    return ok;
  };

  let browser: Awaited<ReturnType<typeof import("playwright-core").chromium.launch>> | undefined;
  let server: ReturnType<typeof createServer> | undefined;
  let buildDir: string | undefined;
  try {
    const chromiumInfo = await loadChromium();
    if (!chromiumInfo) {
      result.skipped = true;
      result.skipReason =
        "未找到独立 Chromium；可设置 ZCODE_TEST_CHROMIUM_PATH 后重跑 Composer 工具栏 fit 验证";
      return result;
    }

    const { build } = await import("vite");
    buildDir = await mkdtemp(join(tmpdir(), "zcode-composer-toolbar-fit-"));
    await build({
      build: { emptyOutDir: true, outDir: buildDir },
      configFile: join(HERE, "vite.config.mts"),
      logLevel: "silent",
    });

    server = await startStaticServer(buildDir);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("静态服务未取得端口");
    const origin = `http://127.0.0.1:${address.port}/`;

    browser = await chromiumInfo.chromium.launch({
      executablePath: chromiumInfo.executablePath,
      headless: true,
    });

    const page = await browser.newPage({ viewport: { height: 800, width: 1280 } });
    page.on("pageerror", (error) => result.pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      const text = message.text();
      if (
        /favicon|Failed to load resource: the server responded with a status of 404/i.test(text)
      ) {
        return;
      }
      result.consoleErrors.push(text);
    });
    await page.goto(origin, { waitUntil: "networkidle" });
    await page.waitForFunction(() => window.__composerToolbarFitReady === true);

    const snapshot = (): Promise<Snapshot> =>
      page.evaluate(() => window.__composerToolbarFitApi!.snapshot());
    const probe = (): Promise<Probe> => page.evaluate(() => window.__composerToolbarFitProbe!);
    const settle = async (quietFrames = 4) => {
      await page.evaluate(
        (frames) => window.__composerToolbarFitApi!.waitUntilQuiet(frames, 160),
        quietFrames,
      );
    };
    const apply = async (patch: Record<string, unknown>, quietFrames = 4) => {
      await page.evaluate((next) => {
        const api = window.__composerToolbarFitApi!;
        api.setPatch(next);
        api.resetCounters();
      }, patch);
      await settle(quietFrames);
      return snapshot();
    };
    const sendInsideRoot = (value: Snapshot): boolean =>
      value.sendRect.width > 0 &&
      value.sendRect.left >= value.rootRect.left - 1 &&
      value.sendRect.right <= value.rootRect.right + 1;

    // 1. 挂载首帧即同步 fit：不等待 rAF 就能读到结果。
    const initial = await snapshot();
    check("mount: first fit 在 layout 阶段同步完成", initial.firstFit !== null, initial.firstFit);
    check(
      "mount: 宽布局不产生紧凑写入",
      initial.firstFit?.modelIcon === false &&
        initial.firstFit?.providerCompact === false &&
        initial.firstFit.compact.every((item) => !item.compact),
      initial.firstFit,
    );

    // 2. 宽窄往返与模式/CUA 优先级。
    const medium = await apply({ cuaVisible: false, locale: "zh", width: 480 });
    check(
      "dynamic entry: 无 CUA 时中等宽度仅保留模式标签",
      medium.compact.find((item) => item.priority === "0")?.compact === false,
      medium.compact,
    );
    const withCua = await apply({ cuaVisible: true, width: 480 });
    check(
      "priority: 空间不足时先收起 priority=0 的模式按钮",
      withCua.compact.find((item) => item.priority === "0")?.compact === true,
      withCua.compact,
    );
    check(
      "priority: 收起模式按钮后 CUA 保持展开",
      withCua.compact.find((item) => item.priority === "1")?.compact === false,
      withCua.compact,
    );
    const narrow = await apply({ width: 360 });
    check(
      "narrow: 两个折叠控件都进入紧凑态",
      narrow.compact.every((item) => item.compact),
      narrow,
    );
    const wide = await apply({ width: 700 });
    check(
      "wide: 宽窄往返后恢复完整布局",
      wide.compact.every((item) => !item.compact) &&
        wide.modelIcon === false &&
        wide.providerCompact === false,
      wide,
    );

    // 3. 语言变化通过控件真实宽度影响折叠结果。
    const zhFit = await apply({ cuaVisible: false, locale: "zh", width: 430 });
    check(
      "locale: 中文短标签在临界宽度保持展开",
      zhFit.compact.find((item) => item.priority === "0")?.compact === false,
      zhFit.compact,
    );
    const enFit = await apply({ locale: "en", width: 430 });
    check(
      "locale: 英文长标签在相同宽度触发模式折叠",
      enFit.compact.find((item) => item.priority === "0")?.compact === true,
      enFit.compact,
    );

    // 4. 模型宽度阈值与图标回退。
    const modelShrink = await apply({ cuaVisible: true, locale: "zh", width: 300 });
    check(
      "model threshold: 中等溢出时缩窄模型最大宽度而非直接图标化",
      modelShrink.modelIcon === false && modelShrink.modelMaxWidth !== "",
      modelShrink,
    );
    const modelIcon = await apply({ width: 180 });
    check(
      "model threshold: 剩余宽度不足 80px 时切换为图标",
      modelIcon.modelIcon === true,
      modelIcon,
    );
    const sendAlwaysVisible = [medium, withCua, narrow, wide, modelShrink, modelIcon].every(
      sendInsideRoot,
    );
    check("send: 所有临界布局下发送按钮仍在工具栏内且可见", sendAlwaysVisible, {
      modelShrink: modelShrink.sendRect,
      narrow: narrow.sendRect,
    });

    // 5. provider 前缀紧凑标记：只在完整布局测量后写入，且稳定不自激。
    const providerCompact = await apply({ provider: "Very Long Provider Name", width: 700 });
    check(
      "provider: 前缀溢出时进入紧凑态",
      providerCompact.providerCompact === true,
      providerCompact,
    );
    await page.evaluate(() => window.__composerToolbarFitApi!.resetCounters());
    await settle(6);
    const providerProbe = await probe();
    check(
      "provider: 结果稳定后没有额外属性写入或探针",
      providerProbe.writes === 0 && providerProbe.clones === 0,
      providerProbe,
    );

    // 6. 同一任务内多种通知只允许一次探针。
    await apply({ cuaVisible: false, locale: "zh", provider: "AI", width: 700 });
    await page.evaluate(() => window.__composerToolbarFitApi!.resetCounters());
    await page.evaluate(() => window.__composerToolbarFitApi!.burstMixed());
    await page.evaluate(() => window.__composerToolbarFitApi!.waitFrames(6));
    const burstProbe = await probe();
    check("coalesce: 同帧通知产生的探针不超过 1 个", burstProbe.maxClonesPerFrame <= 1, burstProbe);
    check("coalesce: 同批通知确实触发了测量", burstProbe.clones >= 1, burstProbe);

    // 7. characterData 只标脏，不重绑观察集合；unrelated childList 也不重绑。
    await settle(6);
    await page.evaluate(() => window.__composerToolbarFitApi!.resetCounters());
    await page.evaluate(() => window.__composerToolbarFitApi!.mutateTextOnly());
    await page.evaluate(() => window.__composerToolbarFitApi!.waitFrames(3));
    const textProbe = await probe();
    check(
      "characterData: 不 disconnect/observe 观察集合",
      textProbe.roDisconnectCalls === 0 && textProbe.roObserveCalls === 0,
      textProbe,
    );
    await page.evaluate(() => window.__composerToolbarFitApi!.resetCounters());
    await page.evaluate(() => window.__composerToolbarFitApi!.appendUnrelated());
    await page.evaluate(() => window.__composerToolbarFitApi!.waitFrames(3));
    const unrelatedProbe = await probe();
    check(
      "childList: 未命中观察集合时不重绑",
      unrelatedProbe.roDisconnectCalls === 0 && unrelatedProbe.roObserveCalls === 0,
      unrelatedProbe,
    );

    // 8. 命中观察集合的 childList（新增被观察容器）必须重绑并重新测量。
    await apply({ extraObserved: false, width: 480 });
    await page.evaluate(() => window.__composerToolbarFitApi!.resetCounters());
    await page.evaluate(() => window.__composerToolbarFitApi!.setPatch({ extraObserved: true }));
    await page.evaluate(() => window.__composerToolbarFitApi!.waitFrames(4));
    const rebindProbe = await probe();
    check(
      "childList: 新增被观察容器时重绑观察集合",
      rebindProbe.roDisconnectCalls >= 1 && rebindProbe.roObserveCalls >= 1,
      rebindProbe,
    );

    // 9. 焦点与 tooltip 不因测量移动：只触发 characterData，不改变布局结果。
    await apply({ cuaVisible: false, locale: "zh", width: 480 });
    const beforeFocus = await snapshot();
    await page.evaluate(() => window.__composerToolbarFitApi!.focusMode());
    const focused = await snapshot();
    await page.evaluate(() => window.__composerToolbarFitApi!.resetCounters());
    await page.evaluate(() => window.__composerToolbarFitApi!.mutateTextOnly());
    await page.evaluate(() => window.__composerToolbarFitApi!.waitFrames(4));
    const afterFocus = await snapshot();
    check(
      "focus: 测量更新后真实模式按钮仍保持焦点",
      focused.activeRole === "mode" && afterFocus.activeRole === "mode",
      { afterFocus: afterFocus.activeRole, focused: focused.activeRole },
    );
    check(
      "tooltip: 真实 tooltip 位置在测量更新前后不变",
      Math.abs(beforeFocus.tooltipRect.left - afterFocus.tooltipRect.left) < 0.5 &&
        Math.abs(beforeFocus.tooltipRect.top - afterFocus.tooltipRect.top) < 0.5,
      { after: afterFocus.tooltipRect, before: beforeFocus.tooltipRect },
    );
    check(
      "probe: 测量结束后不残留隐藏探针",
      afterFocus.liveProbeCount === 0,
      afterFocus.liveProbeCount,
    );

    // 10. 隐藏后显示：隐藏期间不创建探针，恢复可见后重新 fit。
    await apply({ cuaVisible: true, locale: "zh", width: 360 });
    await page.evaluate(() => window.__composerToolbarFitApi!.resetCounters());
    await page.evaluate(() => window.__composerToolbarFitApi!.setPatch({ frameHidden: true }));
    await page.evaluate(() => window.__composerToolbarFitApi!.waitFrames(4));
    const hiddenProbe = await probe();
    check("hidden: 零宽时跳过测量且不创建探针", hiddenProbe.clones === 0, hiddenProbe);
    const shown = await apply({ frameHidden: false, width: 360 });
    check(
      "hidden show: 恢复可见后重新应用正确紧凑态",
      shown.compact.every((item) => item.compact) && shown.liveProbeCount === 0,
      shown,
    );

    // 11. 稳定结果零写入、零探针、不抖动。
    await settle(8);
    await page.evaluate(() => window.__composerToolbarFitApi!.resetCounters());
    const signatures: string[] = [];
    for (let index = 0; index < 8; index += 1) {
      await page.evaluate(() => window.__composerToolbarFitApi!.waitFrames(1));
      const value = await snapshot();
      signatures.push(JSON.stringify({ ...value, rootRect: undefined, sendRect: undefined }));
    }
    const stableProbe = await probe();
    check(
      "stable: 稳定结果不产生额外属性写入或探针",
      stableProbe.writes === 0 && stableProbe.clones === 0,
      stableProbe,
    );
    check(
      "stable: 连续帧紧凑态不抖动",
      signatures.every((value) => value === signatures[signatures.length - 1]),
      signatures,
    );

    // 12. 卸载清理：断开观察器并取消待执行帧，不再产生探针或写入。
    await page.evaluate(() => {
      const api = window.__composerToolbarFitApi!;
      api.resetCounters();
      api.mutateTextOnly();
    });
    await page.evaluate(() => window.__composerToolbarFitApi!.unmount());
    await page.evaluate(() => window.__composerToolbarFitApi!.waitFrames(4));
    const cleanupProbe = await probe();
    check(
      "cleanup: 卸载后不再创建探针或写属性",
      cleanupProbe.clones === 0 && cleanupProbe.writes === 0,
      cleanupProbe,
    );

    check("pageerror 为空", result.pageErrors.length === 0, result.pageErrors);
    check("console.error 为空", result.consoleErrors.length === 0, result.consoleErrors);
    await page.close();
    return result;
  } catch (error) {
    result.assertions.push({
      detail: String(error instanceof Error ? (error.stack ?? error.message) : error),
      name: "执行异常",
      ok: false,
    });
    return result;
  } finally {
    await browser?.close().catch(() => {});
    await new Promise<void>((resolveClose) => {
      if (!server) return resolveClose();
      server.close(() => resolveClose());
    });
    if (buildDir) await rm(buildDir, { force: true, recursive: true }).catch(() => {});
  }
}

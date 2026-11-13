import type { Check, Metrics } from "./scenario-types.js";

export type StyleRecord = {
  id: number;
  first: boolean;
  phase: string;
  connected: boolean;
  html: string;
  nonce: string | null;
};

export type FrameCommit = {
  kind: "scroll" | "select";
  phase: string;
  connected: boolean;
  value: string;
};

export type Snapshot = {
  buildMode: string | null;
  selectOpen: boolean;
  selectValue: string;
  selectTriggerText: string | null;
  selectViewportInDocument: boolean;
  selectStyleInDocument: boolean;
  selectStyleMarker: string | null;
  selectStyleNonce: string | null;
  selectStyleText: string | null;
  selectOptionTexts: string[];
  scrollViewportInDocument: boolean;
  scrollStyleInDocument: boolean;
  scrollStyleMarker: string | null;
  scrollStyleNonce: string | null;
  scrollStyleText: string | null;
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
  scrollThumbState: string | null;
  scrollThumbHeight: number;
  fragmentCount: number;
  fragmentProbe: boolean;
  innerHtmlProbe: boolean;
  frameProbe: boolean;
  records: StyleRecord[];
  frameCommits: FrameCommit[];
};

export const SELECT_CSS = "data-radix-select-viewport";
export const SCROLL_CSS = "data-radix-scroll-area-viewport";

export async function appCall(page: any, method: string, ...args: unknown[]): Promise<any> {
  return page.evaluate(
    (request: { method: string; args: unknown[] }) => {
      const app = (window as any).__radixApp;
      if (!app || typeof app[request.method] !== "function") {
        throw new Error(`__radixApp.${request.method} is missing`);
      }
      return app[request.method](...request.args);
    },
    { method, args },
  );
}

export async function settle(page: any, delay = 0): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
  if (delay > 0) await page.waitForTimeout(delay);
}

export const snapshot = (page: any): Promise<Snapshot> => appCall(page, "snapshot");

export async function waitSelectOpen(page: any, open: boolean): Promise<void> {
  await page.waitForFunction(
    (expected: boolean) =>
      Boolean(document.querySelector("[data-radix-select-viewport]")) === expected,
    open,
    { timeout: 10_000 },
  );
}

export function split(records: StyleRecord[]) {
  return {
    scroll: records.filter((record) => record.html.includes(SCROLL_CSS)),
    select: records.filter((record) => record.html.includes(SELECT_CSS)),
  };
}

function isSequential(values: string[]): boolean {
  return values.every(
    (value, index) => index === 0 || Number(value) === Number(values[index - 1]) + 1,
  );
}

export async function measureForced(
  page: any,
  phase: string,
  count: number,
  check: Check,
  metrics: Metrics,
) {
  await appCall(page, "reset", phase);
  await appCall(page, "forceRerenders", count);
  const snap = await snapshot(page);
  const records = snap.records.filter((record) => record.phase === phase);
  const commits = snap.frameCommits.filter((commit) => commit.phase === phase);
  const splitRecords = split(records);
  const selectCommits = commits.filter((commit) => commit.kind === "select");
  const scrollCommits = commits.filter((commit) => commit.kind === "scroll");
  const selectExtras = splitRecords.select.filter((record) => !record.first);
  const scrollExtras = splitRecords.scroll.filter((record) => !record.first);

  metrics[phase] = {
    select: {
      commits: selectCommits.length,
      connected: selectCommits.map((commit) => commit.connected),
      extras: selectExtras.length,
      ids: [...new Set(splitRecords.select.map((record) => record.id))],
      writes: splitRecords.select.length,
    },
    scroll: {
      commits: scrollCommits.length,
      extras: scrollExtras.length,
      ids: [...new Set(splitRecords.scroll.map((record) => record.id))],
      writes: splitRecords.scroll.length,
    },
  };

  check(`${phase}: 100 次提交到达 Select Viewport`, selectCommits.length === count, {
    commits: selectCommits.length,
  });
  check(`${phase}: 100 次提交到达 ScrollArea Viewport`, scrollCommits.length === count, {
    commits: scrollCommits.length,
  });
  check(
    `${phase}: Select data-frame 逐次递增`,
    isSequential(selectCommits.map((commit) => commit.value)),
    selectCommits.slice(0, 3).map((commit) => commit.value),
  );
  check(
    `${phase}: ScrollArea data-frame 逐次递增`,
    isSequential(scrollCommits.map((commit) => commit.value)),
    scrollCommits.slice(0, 3).map((commit) => commit.value),
  );
  check(
    `${phase}: Select 已存在节点固定样式额外写入为 0`,
    splitRecords.select.length === 0 && selectExtras.length === 0,
    { extras: selectExtras.length, writes: splitRecords.select.length },
  );
  check(
    `${phase}: ScrollArea 已存在节点固定样式额外写入为 0`,
    splitRecords.scroll.length === 0 && scrollExtras.length === 0,
    { extras: scrollExtras.length, writes: splitRecords.scroll.length },
  );
  return snap;
}

export async function setStyleMarkers(page: any): Promise<void> {
  await page.evaluate(() => {
    for (const style of Array.from(document.querySelectorAll("style"))) {
      const text = style.textContent ?? "";
      if (text.includes("data-radix-select-viewport")) style.dataset.probeMarker = "keep-select";
      if (text.includes("data-radix-scroll-area-viewport")) {
        style.dataset.probeMarker = "keep-scroll";
      }
    }
  });
}

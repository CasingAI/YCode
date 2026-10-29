import assert from "node:assert/strict";
import { isUtf8 } from "node:buffer";
import test from "node:test";
import { FILE_TEXT_WINDOW_CHANGED_CODE, FILE_TEXT_WINDOW_MAX_BYTES } from "@zcode/shared";
import type { FileTextWindow } from "@zcode/shared";
import {
  FILES_LARGE_TEXT_BLOCK_STEP,
  filesLargeTextBlockCount,
} from "../src/files-workbench/filesLargeTextBlockModel.js";
import {
  acquireFilesLargeTextWindow,
  seedFilesLargeTextWindow,
  type FilesLargeTextWindowOwner,
  type FilesLargeTextWindowReadParams,
} from "../src/files-workbench/filesLargeTextWindowStore.js";

const decoder = new TextDecoder("utf-8", { fatal: false });
const encoder = new TextEncoder();

let serial = 0;
function owner(path = "/workspace/block-boundary.log"): FilesLargeTextWindowOwner {
  serial += 1;
  return {
    bufferId: `large:block-request:${serial}`,
    workspaceKey: "workspace-a",
    remoteSessionId: "",
    path,
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** 虚拟文件：默认填充 'A'，只分配单次窗口范围，支持 >1 GiB 稀疏读取。 */
function createSource(
  totalBytes: number,
  patches: Array<{ offset: number; bytes: Uint8Array }> = [],
): {
  totalBytes: number;
  read: (start: number, end: number) => Uint8Array;
  stats: () => { readCalls: number; bytesRead: number };
} {
  let readCalls = 0;
  let bytesRead = 0;
  return {
    totalBytes,
    stats: () => ({ readCalls, bytesRead }),
    read: (start, end) => {
      readCalls += 1;
      bytesRead += Math.max(0, end - start);
      const out = new Uint8Array(Math.max(0, end - start)).fill(0x41);
      for (const patch of patches) {
        const from = Math.max(start, patch.offset);
        const to = Math.min(end, patch.offset + patch.bytes.length);
        if (to <= from) continue;
        out.set(patch.bytes.subarray(from - patch.offset, to - patch.offset), from - start);
      }
      return out;
    },
  };
}

function isContinuation(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

function sequenceLength(lead: number): number {
  if (lead >= 0xc2 && lead <= 0xdf) return 2;
  if (lead >= 0xe0 && lead <= 0xef) return 3;
  if (lead >= 0xf0 && lead <= 0xf4) return 4;
  return 0;
}

/** 与文件服务一致：只有落在**合法**码点内部才回退，非法 continuation 保持请求偏移。 */
function validCodePointStart(buffer: Uint8Array, index: number): number | undefined {
  const byte = buffer[index];
  if (byte === undefined || !isContinuation(byte)) return undefined;
  for (let leadIndex = index - 1; leadIndex >= Math.max(0, index - 3); leadIndex -= 1) {
    const lead = buffer[leadIndex];
    if (lead === undefined || isContinuation(lead)) continue;
    const length = sequenceLength(lead);
    if (length === 0) return undefined;
    const end = leadIndex + length;
    if (end <= index || end > buffer.length) return undefined;
    return isUtf8(buffer.subarray(leadIndex, end)) ? leadIndex : undefined;
  }
  return undefined;
}

/** 复刻 IFileService.readTextFileWindow 的对齐、回退、版本与解码错误语义。 */
function createServiceReader(source: ReturnType<typeof createSource>, initialVersion = "v-raw") {
  const calls: FilesLargeTextWindowReadParams[] = [];
  let version = initialVersion;
  const failAtCallIndex = new Set<number>();
  let beforeCall: ((index: number) => void) | undefined;

  const read = async (params: FilesLargeTextWindowReadParams): Promise<FileTextWindow> => {
    calls.push({ ...params });
    const index = calls.length - 1;
    beforeCall?.(index);
    if (failAtCallIndex.has(index)) {
      throw new Error("transient-read-failure");
    }
    if (params.expectedVersion !== undefined && params.expectedVersion !== version) {
      throw { code: FILE_TEXT_WINDOW_CHANGED_CODE };
    }
    const totalBytes = source.totalBytes;
    const requestedOffset = params.offset;
    const readLength = Math.min(params.length, FILE_TEXT_WINDOW_MAX_BYTES);
    if (requestedOffset >= totalBytes) {
      return {
        path: params.path,
        content: "",
        offset: totalBytes,
        bytesRead: 0,
        nextOffset: totalBytes,
        totalBytes,
        version,
        isBinary: false,
        eof: true,
        hasDecodingErrors: false,
        truncated: false,
      };
    }

    const probeStart = Math.max(0, requestedOffset - 3);
    const probeEnd = Math.min(totalBytes, requestedOffset + 4);
    const probe = source.read(probeStart, probeEnd);
    const leadIndex = validCodePointStart(probe, requestedOffset - probeStart);
    const alignedStart = leadIndex === undefined ? requestedOffset : probeStart + leadIndex;

    const desiredEnd = Math.min(totalBytes, alignedStart + readLength);
    const readSize = Math.min(
      totalBytes - alignedStart,
      desiredEnd - alignedStart + 4,
    );
    const buffer = source.read(alignedStart, alignedStart + readSize);
    const relativeDesiredEnd = Math.min(desiredEnd - alignedStart, buffer.length);
    const endLead = validCodePointStart(buffer, relativeDesiredEnd);
    const resolvedEnd = endLead === undefined ? alignedStart + relativeDesiredEnd : alignedStart + endLead;
    const minimumEnd = Math.min(totalBytes, requestedOffset + 1);
    const end = Math.min(
      Math.max(resolvedEnd, minimumEnd),
      alignedStart + buffer.length,
    );
    const raw = buffer.subarray(0, Math.max(0, end - alignedStart));
    return {
      path: params.path,
      content: decoder.decode(raw),
      offset: alignedStart,
      bytesRead: raw.length,
      nextOffset: end,
      totalBytes,
      version,
      isBinary: false,
      eof: end >= totalBytes,
      hasDecodingErrors: raw.length > 0 && !isUtf8(raw),
      truncated: end < totalBytes,
    };
  };

  return {
    calls,
    read,
    setVersion: (next: string) => {
      version = next;
    },
    failAt: (index: number) => failAtCallIndex.add(index),
    clearFailures: () => failAtCallIndex.clear(),
    onBeforeCall: (handler: ((index: number) => void) | undefined) => {
      beforeCall = handler;
    },
  };
}

async function seedWindow(
  key: FilesLargeTextWindowOwner,
  reader: ReturnType<typeof createServiceReader>,
): Promise<FileTextWindow> {
  const window = await reader.read({ path: key.path, offset: 0, length: FILE_TEXT_WINDOW_MAX_BYTES });
  reader.calls.length = 0;
  return window;
}

test("raw 非法 + 2/3/4 字节码点跨 nominalEnd：结束边界探查出真实结束位置，精确复核范围与下一块连续", async () => {
  const scenarios = [
    { name: "2-byte@-1", text: "é", start: FILES_LARGE_TEXT_BLOCK_STEP - 1, forward: 1 },
    { name: "3-byte@-2", text: "€", start: FILES_LARGE_TEXT_BLOCK_STEP - 2, forward: 1 },
    { name: "3-byte@-1", text: "€", start: FILES_LARGE_TEXT_BLOCK_STEP - 1, forward: 2 },
    { name: "4-byte@-3", text: "😀", start: FILES_LARGE_TEXT_BLOCK_STEP - 3, forward: 1 },
    { name: "4-byte@-1", text: "😀", start: FILES_LARGE_TEXT_BLOCK_STEP - 1, forward: 3 },
  ];

  for (const scenario of scenarios) {
    const totalBytes = FILES_LARGE_TEXT_BLOCK_STEP + 128;
    const source = createSource(totalBytes, [
      // 块头非法字节：本块必须只读，但边界仍要完整前进到码点之后。
      { offset: 9, bytes: Uint8Array.from([0x80]) },
      { offset: scenario.start, bytes: encoder.encode(scenario.text) },
    ]);
    const reader = createServiceReader(source);
    const lease = acquireFilesLargeTextWindow({
      owner: owner(`/workspace/${scenario.name}.log`),
      initialTotalBytes: totalBytes,
      readWindow: reader.read,
    });
    try {
      lease.ensureLoaded();
      await flush();

      const expectedEnd = FILES_LARGE_TEXT_BLOCK_STEP + scenario.forward;
      assert.equal(reader.calls.length, 3, scenario.name);
      assert.deepEqual(
        { offset: reader.calls[0]?.offset, length: reader.calls[0]?.length },
        { offset: 0, length: FILE_TEXT_WINDOW_MAX_BYTES },
        scenario.name,
      );
      assert.equal(reader.calls[0]?.expectedVersion, undefined, scenario.name);
      // 结束边界探查：只读 4 字节，钉住首窗版本。
      assert.deepEqual(
        {
          offset: reader.calls[1]?.offset,
          length: reader.calls[1]?.length,
          expectedVersion: reader.calls[1]?.expectedVersion,
        },
        {
          offset: FILES_LARGE_TEXT_BLOCK_STEP,
          length: 4,
          expectedVersion: "v-raw",
        },
        scenario.name,
      );
      // 精确范围必须是 [actualStart, actualEnd)，不能停在 nominalEnd。
      assert.deepEqual(
        {
          offset: reader.calls[2]?.offset,
          length: reader.calls[2]?.length,
          expectedVersion: reader.calls[2]?.expectedVersion,
        },
        { offset: 0, length: expectedEnd, expectedVersion: "v-raw" },
        scenario.name,
      );

      const block0 = lease.getSnapshot().block!;
      assert.equal(block0.offset, 0, scenario.name);
      assert.equal(block0.nextOffset, expectedEnd, scenario.name);
      assert.equal(block0.hasDecodingErrors, true, scenario.name);
      assert.equal(block0.needsExactConfirmation, false, scenario.name);
      assert.ok(block0.nextOffset - block0.offset <= FILE_TEXT_WINDOW_MAX_BYTES, scenario.name);
      assert.equal(
        decoder.decode(source.read(0, expectedEnd)),
        block0.content,
        `${scenario.name}: 精确内容必须来自原始字节`,
      );

      // 下一块从 actualEnd 开始，不留下被截断的码点字节空洞。
      lease.navigate({ kind: "next" });
      await flush();
      const block1 = lease.getSnapshot().block!;
      assert.equal(block1.offset, expectedEnd, scenario.name);
      assert.equal(block1.nextOffset, totalBytes, scenario.name);
      assert.equal(block1.hasDecodingErrors, false, scenario.name);
      assert.equal(block1.content.startsWith(scenario.text), false, scenario.name);
    } finally {
      lease.release();
    }
  }
});

test("块起点落在非法 continuation 串：保持请求 offset，不按替换字符反推起点", async () => {
  const totalBytes = FILES_LARGE_TEXT_BLOCK_STEP * 2 + 128;
  const source = createSource(totalBytes, [
    // block1 起点及其前后都是非法 continuation：服务不回退，块起点必须保持 nominalStart。
    { offset: FILES_LARGE_TEXT_BLOCK_STEP - 1, bytes: Uint8Array.from([0x80]) },
    { offset: FILES_LARGE_TEXT_BLOCK_STEP, bytes: Uint8Array.from([0x80, 0x80]) },
  ]);
  const reader = createServiceReader(source);
  const lease = acquireFilesLargeTextWindow({
    owner: owner("/workspace/invalid-start.log"),
    initialTotalBytes: totalBytes,
    readWindow: reader.read,
  });
  try {
    lease.ensureLoaded();
    await flush();
    lease.navigate({ kind: "next" });
    await flush();

    const block = lease.getSnapshot().block!;
    assert.equal(block.blockIndex, 1);
    assert.equal(block.offset, FILES_LARGE_TEXT_BLOCK_STEP);
    assert.equal(block.nextOffset, FILES_LARGE_TEXT_BLOCK_STEP * 2);
    assert.equal(block.hasDecodingErrors, true);
    // 结束边界探查落在合法 ASCII 边界，不移动。
    const probeCall = reader.calls.find(
      (call) => call.offset === FILES_LARGE_TEXT_BLOCK_STEP * 2 && call.length === 4,
    );
    assert.ok(probeCall);
    const exactCall = reader.calls.find(
      (call) =>
        call.offset === FILES_LARGE_TEXT_BLOCK_STEP &&
        call.length === FILES_LARGE_TEXT_BLOCK_STEP,
    );
    assert.ok(exactCall);
    assert.equal(exactCall.expectedVersion, "v-raw");

    // 下一块从 2 * STEP 开始，非法串没有被块切出空洞。
    lease.navigate({ kind: "next" });
    await flush();
    assert.equal(lease.getSnapshot().block?.offset, FILES_LARGE_TEXT_BLOCK_STEP * 2);
    assert.equal(lease.getSnapshot().block?.nextOffset, totalBytes);
  } finally {
    lease.release();
  }
});

test("CRLF 跨 nominalEnd 时保持名义边界，不做码点前进", async () => {
  const totalBytes = FILES_LARGE_TEXT_BLOCK_STEP + 128;
  const source = createSource(totalBytes, [
    { offset: 9, bytes: Uint8Array.from([0x80]) },
    { offset: FILES_LARGE_TEXT_BLOCK_STEP - 1, bytes: Uint8Array.from([0x0d, 0x0a]) },
  ]);
  const reader = createServiceReader(source);
  const lease = acquireFilesLargeTextWindow({
    owner: owner("/workspace/crlf-boundary.log"),
    initialTotalBytes: totalBytes,
    readWindow: reader.read,
  });
  try {
    lease.ensureLoaded();
    await flush();
    assert.equal(reader.calls.length, 3);
    assert.equal(reader.calls[1]?.offset, FILES_LARGE_TEXT_BLOCK_STEP);
    assert.equal(reader.calls[1]?.length, 4);
    assert.equal(reader.calls[2]?.offset, 0);
    assert.equal(reader.calls[2]?.length, FILES_LARGE_TEXT_BLOCK_STEP);

    const block0 = lease.getSnapshot().block!;
    assert.equal(block0.nextOffset, FILES_LARGE_TEXT_BLOCK_STEP);
    assert.equal(block0.content.endsWith("\r"), true);
    lease.navigate({ kind: "next" });
    await flush();
    const block1 = lease.getSnapshot().block!;
    assert.equal(block1.offset, FILES_LARGE_TEXT_BLOCK_STEP);
    assert.equal(block1.content.startsWith("\n"), true);
  } finally {
    lease.release();
  }
});

test("合法窗口被服务尾部回退截短时仍做结束边界探查补足实际结束位置，避免相邻块空洞", async () => {
  const totalBytes = FILES_LARGE_TEXT_BLOCK_STEP * 2 + 1000;
  const source = createSource(totalBytes, [
    // block1 起点回退 3 字节：4 字节码点跨 nominalStart(1)。
    { offset: FILES_LARGE_TEXT_BLOCK_STEP - 3, bytes: encoder.encode("😀") },
    // 4 字节码点从 nominalEnd(1) - 2 开始，服务尾部回退会让 raw 窗口止于它之前。
    { offset: FILES_LARGE_TEXT_BLOCK_STEP * 2 - 2, bytes: encoder.encode("😀") },
  ]);
  const reader = createServiceReader(source);
  const lease = acquireFilesLargeTextWindow({
    owner: owner("/workspace/short-valid-window.log"),
    initialTotalBytes: totalBytes,
    readWindow: reader.read,
  });
  try {
    lease.ensureLoaded();
    await flush();
    lease.navigate({ kind: "next" });
    await flush();

    const block1 = lease.getSnapshot().block!;
    assert.equal(block1.blockIndex, 1);
    // 起点回退 3 字节后落在跨块码点之后：STEP + 1。
    assert.equal(block1.offset, FILES_LARGE_TEXT_BLOCK_STEP + 1);
    // 真实结束位置必须越过跨 nominalEnd 的完整码点：2 * STEP + 2。
    assert.equal(block1.nextOffset, FILES_LARGE_TEXT_BLOCK_STEP * 2 + 2);
    assert.equal(block1.hasDecodingErrors, false);
    assert.equal(block1.needsExactConfirmation, false);

    lease.navigate({ kind: "next" });
    await flush();
    const block2 = lease.getSnapshot().block!;
    assert.equal(block2.offset, block1.nextOffset, "next block must start at actualEnd");
    assert.equal(block2.content.startsWith("😀"), false);
  } finally {
    lease.release();
  }
});

test("非法字节只在越界尾部：本块精确复核后合法，恢复可编辑", async () => {
  const totalBytes = FILES_LARGE_TEXT_BLOCK_STEP + 128;
  const source = createSource(totalBytes, [
    // 错误位于下一块（>= STEP），本块 [0, STEP) 全部合法。
    { offset: FILES_LARGE_TEXT_BLOCK_STEP + 1, bytes: Uint8Array.from([0x80]) },
  ]);
  const reader = createServiceReader(source);
  const lease = acquireFilesLargeTextWindow({
    owner: owner("/workspace/lookahead-bad.log"),
    initialTotalBytes: totalBytes,
    readWindow: reader.read,
  });
  try {
    lease.ensureLoaded();
    await flush();
    assert.equal(reader.calls.length, 3);
    assert.equal(reader.calls[1]?.offset, FILES_LARGE_TEXT_BLOCK_STEP);
    assert.equal(reader.calls[1]?.length, 4);
    assert.equal(reader.calls[2]?.offset, 0);
    assert.equal(reader.calls[2]?.length, FILES_LARGE_TEXT_BLOCK_STEP);

    const block = lease.getSnapshot().block!;
    assert.equal(block.offset, 0);
    assert.equal(block.nextOffset, FILES_LARGE_TEXT_BLOCK_STEP);
    assert.equal(block.hasDecodingErrors, false);
    assert.equal(block.needsExactConfirmation, false);
    assert.equal(block.content.length, FILES_LARGE_TEXT_BLOCK_STEP);
  } finally {
    lease.release();
  }
});

test("最后一块 / 精确块边界 / EOF：不再发结束边界探查", async () => {
  const exactTotal = FILES_LARGE_TEXT_BLOCK_STEP;
  const exactSource = createSource(exactTotal, [
    { offset: 100, bytes: Uint8Array.from([0x80]) },
  ]);
  const exactReader = createServiceReader(exactSource);
  const exactLease = acquireFilesLargeTextWindow({
    owner: owner("/workspace/exact-boundary.log"),
    initialTotalBytes: exactTotal,
    readWindow: exactReader.read,
  });
  try {
    exactLease.ensureLoaded();
    await flush();
    assert.equal(exactReader.calls.length, 1);
    assert.equal(exactLease.getSnapshot().block?.nextOffset, exactTotal);
    assert.equal(exactLease.getSnapshot().block?.hasDecodingErrors, true);
    assert.equal(exactLease.getSnapshot().block?.needsExactConfirmation, false);
  } finally {
    exactLease.release();
  }

  const tailTotal = FILES_LARGE_TEXT_BLOCK_STEP * 2;
  const tailSource = createSource(tailTotal, [
    { offset: tailTotal - 10, bytes: Uint8Array.from([0x80]) },
  ]);
  const tailReader = createServiceReader(tailSource);
  const tailLease = acquireFilesLargeTextWindow({
    owner: owner("/workspace/tail-block.log"),
    initialTotalBytes: tailTotal,
    readWindow: tailReader.read,
  });
  try {
    tailLease.ensureLoaded();
    await flush();
    tailLease.navigate({ kind: "next" });
    await flush();
    assert.equal(tailReader.calls.length, 2);
    assert.equal(tailReader.calls[1]?.offset, FILES_LARGE_TEXT_BLOCK_STEP);
    assert.equal(tailLease.getSnapshot().block?.blockIndex, 1);
    assert.equal(tailLease.getSnapshot().block?.nextOffset, tailTotal);
    assert.equal(tailLease.getSnapshot().block?.hasDecodingErrors, true);
    assert.equal(tailLease.getSnapshot().block?.needsExactConfirmation, false);
  } finally {
    tailLease.release();
  }
});

test("边界探查与精确复核都钉住首窗版本；中途版本变化不提交混版", async () => {
  const totalBytes = FILES_LARGE_TEXT_BLOCK_STEP + 128;
  const source = createSource(totalBytes, [
    { offset: 9, bytes: Uint8Array.from([0x80]) },
  ]);
  const reader = createServiceReader(source);
  reader.onBeforeCall((index) => {
    // 首窗读完后磁盘被改写：后续边界探查必须因版本不符被拒绝。
    if (index === 1) reader.setVersion("v-next");
  });
  const lease = acquireFilesLargeTextWindow({
    owner: owner("/workspace/version-mixed.log"),
    initialTotalBytes: totalBytes,
    readWindow: reader.read,
  });
  try {
    lease.ensureLoaded();
    await flush();
    assert.equal(reader.calls.length, 2);
    assert.equal(reader.calls[1]?.expectedVersion, "v-raw");
    const snapshot = lease.getSnapshot();
    assert.equal(snapshot.window, null);
    assert.equal(snapshot.phase, "error");
    assert.equal(snapshot.error?.kind, "changed");
    assert.equal(snapshot.block, null);
  } finally {
    lease.release();
  }
});

test("已有窗口时边界探查遇到版本变化：保留旧块只提示，不替换", async () => {
  const totalBytes = FILES_LARGE_TEXT_BLOCK_STEP * 3;
  const source = createSource(totalBytes, [
    { offset: FILES_LARGE_TEXT_BLOCK_STEP + 10, bytes: Uint8Array.from([0x80]) },
  ]);
  const reader = createServiceReader(source);
  const lease = acquireFilesLargeTextWindow({
    owner: owner("/workspace/version-keep-old.log"),
    initialTotalBytes: totalBytes,
    readWindow: reader.read,
  });
  try {
    lease.ensureLoaded();
    await flush();
    const initialContent = lease.getSnapshot().block?.content;
    assert.equal(lease.getSnapshot().block?.blockIndex, 0);

    reader.onBeforeCall((index) => {
      if (index === 2) reader.setVersion("v-next");
    });
    lease.navigate({ kind: "next" });
    await flush();

    assert.equal(reader.calls.length, 3);
    assert.equal(reader.calls[2]?.expectedVersion, "v-raw");
    const snapshot = lease.getSnapshot();
    assert.equal(snapshot.window?.version, "v-raw");
    assert.equal(snapshot.block?.blockIndex, 0);
    assert.equal(snapshot.block?.content, initialContent);
    assert.equal(snapshot.stale, true);
    assert.equal(snapshot.error?.kind, "changed");
  } finally {
    lease.release();
  }
});

test("seed 的 needsExactConfirmation 等 ensureLoaded 重读；失败保留标记，重试后可编辑", async () => {
  const totalBytes = FILES_LARGE_TEXT_BLOCK_STEP + 128;
  const source = createSource(totalBytes, [
    // 错误只在下一块，精确范围应恢复为可编辑。
    { offset: FILES_LARGE_TEXT_BLOCK_STEP + 1, bytes: Uint8Array.from([0x80]) },
  ]);
  const seedReader = createServiceReader(source, "v-seed");
  const key = owner("/workspace/seed-retry.log");
  const seeded = await seedWindow(key, seedReader);
  assert.equal(seeded.hasDecodingErrors, true);
  assert.equal(seedFilesLargeTextWindow(key, seeded), true);

  const reader = createServiceReader(source, "v-seed");
  reader.failAt(1);
  const lease = acquireFilesLargeTextWindow({
    owner: key,
    initialTotalBytes: totalBytes,
    readWindow: reader.read,
  });
  try {
    lease.ensureLoaded();
    await flush();
    assert.equal(reader.calls.length, 2);
    assert.equal(reader.calls[1]?.expectedVersion, "v-seed");
    const failed = lease.getSnapshot();
    assert.equal(failed.error?.kind, "failed");
    assert.equal(failed.block?.needsExactConfirmation, true);
    assert.equal(failed.block?.hasDecodingErrors, true);

    // 失败不预先清标记：下一次 ensureLoaded 仍走同一精确复核。
    reader.clearFailures();
    lease.ensureLoaded();
    await flush();
    assert.equal(reader.calls.length, 5);
    assert.equal(reader.calls[2]?.offset, 0);
    assert.equal(reader.calls[2]?.expectedVersion, "v-seed");
    assert.equal(reader.calls[3]?.offset, FILES_LARGE_TEXT_BLOCK_STEP);
    assert.equal(reader.calls[4]?.length, FILES_LARGE_TEXT_BLOCK_STEP);

    const fixed = lease.getSnapshot();
    assert.equal(fixed.error, null);
    assert.equal(fixed.block?.needsExactConfirmation, false);
    assert.equal(fixed.block?.hasDecodingErrors, false);
    assert.equal(fixed.block?.nextOffset, FILES_LARGE_TEXT_BLOCK_STEP);
  } finally {
    lease.release();
  }
});

test("> 1 GiB 稀疏文件只读目标块，不做全文扫描", async () => {
  const totalBytes = 1_610_612_736; // 1.5 GiB
  const source = createSource(totalBytes);
  const reader = createServiceReader(source);
  const lease = acquireFilesLargeTextWindow({
    owner: owner("/workspace/sparse-1_5g.log"),
    initialTotalBytes: totalBytes,
    readWindow: reader.read,
  });
  try {
    lease.ensureLoaded();
    await flush();
    lease.navigate({ kind: "end" });
    await flush();

    const lastBlockIndex = filesLargeTextBlockCount(totalBytes) - 1;
    assert.equal(reader.calls.length, 2);
    assert.equal(reader.calls[1]?.offset, lastBlockIndex * FILES_LARGE_TEXT_BLOCK_STEP);
    assert.equal(lease.getSnapshot().block?.blockIndex, lastBlockIndex);
    assert.equal(lease.getSnapshot().block?.nextOffset, totalBytes);
    assert.equal(lease.getSnapshot().block?.hasDecodingErrors, false);

    const stats = source.stats();
    assert.ok(stats.readCalls <= 8, `readCalls=${stats.readCalls}`);
    assert.ok(
      stats.bytesRead <= 8 * FILE_TEXT_WINDOW_MAX_BYTES,
      `bytesRead=${stats.bytesRead}`,
    );
  } finally {
    lease.release();
  }
});

test("逐块加载相邻范围首尾相接，无空洞 / 重叠，每块 ≤ 256 KiB", async () => {
  const totalBytes = FILES_LARGE_TEXT_BLOCK_STEP * 3 + 50;
  const source = createSource(totalBytes, [
    // 3 字节码点跨 block0/block1 边界。
    { offset: FILES_LARGE_TEXT_BLOCK_STEP - 1, bytes: encoder.encode("€") },
    // block1 内的非法字节。
    { offset: FILES_LARGE_TEXT_BLOCK_STEP + 200, bytes: Uint8Array.from([0x80]) },
    // 4 字节码点跨 block1/block2 边界。
    { offset: FILES_LARGE_TEXT_BLOCK_STEP * 2 - 1, bytes: encoder.encode("😀") },
    // block2 内的非法字节。
    { offset: FILES_LARGE_TEXT_BLOCK_STEP * 2 + 200, bytes: Uint8Array.from([0x80]) },
  ]);
  const reader = createServiceReader(source);
  const lease = acquireFilesLargeTextWindow({
    owner: owner("/workspace/contiguous-blocks.log"),
    initialTotalBytes: totalBytes,
    readWindow: reader.read,
  });
  try {
    lease.ensureLoaded();
    await flush();
    const ranges: Array<{ offset: number; nextOffset: number; errors: boolean }> = [];
    const lastBlockIndex = filesLargeTextBlockCount(totalBytes) - 1;
    for (let index = 0; index <= lastBlockIndex; index += 1) {
      if (index > 0) {
        lease.navigate({ kind: "next" });
        await flush();
      }
      const block = lease.getSnapshot().block!;
      assert.equal(block.blockIndex, index);
      ranges.push({
        offset: block.offset,
        nextOffset: block.nextOffset,
        errors: block.hasDecodingErrors,
      });
    }

    assert.equal(ranges[0]?.offset, 0);
    assert.equal(ranges[ranges.length - 1]?.nextOffset, totalBytes);
    for (let index = 0; index < ranges.length; index += 1) {
      const range = ranges[index]!;
      assert.ok(range.nextOffset > range.offset, `block ${index} 必须前进`);
      assert.ok(
        range.nextOffset - range.offset <= FILE_TEXT_WINDOW_MAX_BYTES,
        `block ${index} length=${range.nextOffset - range.offset}`,
      );
      if (index > 0) {
        assert.equal(range.offset, ranges[index - 1]?.nextOffset, `block ${index} 有空洞或重叠`);
      }
    }
    assert.equal(ranges[1]?.errors, true);
    assert.equal(ranges[2]?.errors, true);
    assert.equal(ranges[3]?.errors, false);
  } finally {
    lease.release();
  }
});

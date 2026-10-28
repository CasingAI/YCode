import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { FileStat } from "@zcode/shared";
import type { IFileService } from "@zcode/services";
import {
  IMAGE_PREVIEW_MAX_BYTES,
  ImagePreviewError,
  readImagePreviewBlob,
} from "../src/lib/imagePreviewData.js";
import { isMissingFileError } from "../src/lib/fileReadError.js";

type PreviewFileService = Pick<IFileService, "stat" | "readFileRange" | "readMediaPreview">;

const MiB = 1024 * 1024;

interface RangeCall {
  offset: number;
  length: number;
}

interface FakeServiceOptions {
  stat: (callIndex: number) => FileStat | Promise<FileStat>;
  readFileRange?: (call: RangeCall) => Uint8Array | Promise<Uint8Array>;
  readMediaPreview?: (params: { path: string }) => Promise<{
    path: string;
    mediaType: string;
    dataBase64: string;
    totalBytes: number;
  }>;
}

function createFakeService(options: FakeServiceOptions): {
  service: PreviewFileService;
  rangeCalls: RangeCall[];
  legacyCalls: Array<{ path: string }>;
  statCalls: () => number;
} {
  const rangeCalls: RangeCall[] = [];
  const legacyCalls: Array<{ path: string }> = [];
  let statCallCount = 0;
  const service: PreviewFileService = {
    async stat() {
      statCallCount += 1;
      return options.stat(statCallCount);
    },
    async readFileRange({ offset, length }) {
      const call = { offset, length };
      rangeCalls.push(call);
      if (!options.readFileRange) {
        throw new Error("unexpected readFileRange");
      }
      return options.readFileRange(call);
    },
    async readMediaPreview(params) {
      legacyCalls.push(params);
      if (!options.readMediaPreview) {
        throw new Error("unexpected readMediaPreview");
      }
      return options.readMediaPreview(params);
    },
  };
  return {
    service,
    rangeCalls,
    legacyCalls,
    statCalls: () => statCallCount,
  };
}

function deterministicBytes(size: number, seed = 0): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) {
    bytes[index] = (index + seed) & 0xff;
  }
  return bytes;
}

async function sha256OfBlob(blob: Blob): Promise<string> {
  return createHash("sha256")
    .update(Buffer.from(await blob.arrayBuffer()))
    .digest("hex");
}

function fileStat(size: number | undefined): FileStat {
  return { path: "/work/image.png", type: "file", size };
}

function expectImagePreviewError(code: string) {
  return (error: unknown) =>
    error instanceof ImagePreviewError && error.code === code && !error.message.includes("/work/");
}

test("4.55 MiB 与超过 8 MiB 的图片走串行不超过 1 MiB 的 range，不走 base64", async () => {
  for (const size of [4_775_548, 9 * MiB + 123]) {
    const data = deterministicBytes(size, size % 251);
    const fake = createFakeService({
      stat: () => fileStat(size),
      readFileRange: ({ offset, length }) => data.slice(offset, offset + length),
    });

    const blob = await readImagePreviewBlob({
      fileService: fake.service,
      path: "/work/image.png",
      mediaType: "image/png",
    });

    assert.ok(blob);
    assert.equal(blob.size, size);
    assert.equal(blob.type, "image/png");
    assert.equal(
      await sha256OfBlob(blob),
      createHash("sha256").update(Buffer.from(data)).digest("hex"),
    );
    assert.equal(fake.legacyCalls.length, 0);
    assert.ok(fake.rangeCalls.every(({ length }) => length <= MiB));
    assert.equal(
      fake.rangeCalls.reduce((sum, { length }) => sum + length, 0),
      size,
    );
    let expectedOffset = 0;
    for (const call of fake.rangeCalls) {
      assert.equal(call.offset, expectedOffset);
      expectedOffset += call.length;
    }
  }
});

test("分块保留 subarray 与 Buffer 的视图范围，并隔离复用及共享缓冲", async () => {
  const data = deterministicBytes(MiB + 17, 31);
  const backingBuffers = [
    new Uint8Array(MiB + 6),
    Buffer.alloc(MiB + 6),
    new Uint8Array(new SharedArrayBuffer(MiB + 6)),
  ];
  for (const backing of backingBuffers) {
    const fake = createFakeService({
      stat: () => fileStat(data.length),
      readFileRange: ({ offset, length }) => {
        backing.fill(0xff);
        backing.set(data.subarray(offset, offset + length), 3);
        return backing.subarray(3, 3 + length);
      },
    });

    const blob = await readImagePreviewBlob({
      fileService: fake.service,
      path: "/work/image.png",
      mediaType: "image/png",
    });

    assert.ok(blob);
    assert.equal(blob.size, data.length);
    assert.equal(
      await sha256OfBlob(blob),
      createHash("sha256").update(Buffer.from(data)).digest("hex"),
    );
  }
});

test("初始目录不读取，读取结束变为目录时不创建图片", async () => {
  const directory = createFakeService({
    stat: () => ({ ...fileStat(0), type: "directory" }),
  });
  await assert.rejects(
    readImagePreviewBlob({
      fileService: directory.service,
      path: "/work/image.png",
      mediaType: "image/png",
    }),
    expectImagePreviewError("not-file"),
  );
  assert.equal(directory.rangeCalls.length, 0);
  assert.equal(directory.legacyCalls.length, 0);

  const replaced = createFakeService({
    stat: (call) => ({ ...fileStat(3), type: call === 1 ? "file" : "directory" }),
    readFileRange: ({ length }) => new Uint8Array(length),
  });
  await assert.rejects(
    readImagePreviewBlob({
      fileService: replaced.service,
      path: "/work/image.png",
      mediaType: "image/png",
    }),
    expectImagePreviewError("size-changed"),
  );
});

test("1 MiB 边界：整块一次读完，多 1 字节时追加小块", async () => {
  for (const [size, expectedLengths] of [
    [MiB, [MiB]],
    [MiB + 1, [MiB, 1]],
  ] as const) {
    const data = deterministicBytes(size, 7);
    const fake = createFakeService({
      stat: () => fileStat(size),
      readFileRange: ({ offset, length }) => data.slice(offset, offset + length),
    });

    const blob = await readImagePreviewBlob({
      fileService: fake.service,
      path: "/work/image.png",
      mediaType: "image/png",
    });

    assert.ok(blob);
    assert.equal(blob.size, size);
    assert.deepEqual(
      fake.rangeCalls.map(({ length }) => length),
      [...expectedLengths],
    );
  }
});

test("64 MiB 边界允许读取，超过 64 MiB 在 range 前拒绝", async () => {
  const allowed = createFakeService({
    stat: () => fileStat(IMAGE_PREVIEW_MAX_BYTES),
    // 复用同一块模式数据，避免为 64 MiB 再存一份独立源数据。
    readFileRange: ({ length }) => new Uint8Array(length),
  });
  const allowedBlob = await readImagePreviewBlob({
    fileService: allowed.service,
    path: "/work/image.png",
    mediaType: "image/png",
  });
  assert.ok(allowedBlob);
  assert.equal(allowedBlob.size, IMAGE_PREVIEW_MAX_BYTES);
  assert.equal(allowed.rangeCalls.length, IMAGE_PREVIEW_MAX_BYTES / MiB);
  assert.ok(allowed.rangeCalls.every(({ length }) => length === MiB));
  assert.equal(allowed.legacyCalls.length, 0);

  const oversized = createFakeService({
    stat: () => fileStat(IMAGE_PREVIEW_MAX_BYTES + 1),
  });
  await assert.rejects(
    readImagePreviewBlob({
      fileService: oversized.service,
      path: "/work/image.png",
      mediaType: "image/png",
    }),
    expectImagePreviewError("too-large"),
  );
  assert.equal(oversized.rangeCalls.length, 0);
  assert.equal(oversized.legacyCalls.length, 0);
});

test("0 字节返回空 Blob；非法 size 直接拒绝且不读字节", async () => {
  const empty = createFakeService({
    stat: () => fileStat(0),
  });
  const emptyBlob = await readImagePreviewBlob({
    fileService: empty.service,
    path: "/work/image.png",
    mediaType: "image/png",
  });
  assert.ok(emptyBlob);
  assert.equal(emptyBlob.size, 0);
  assert.equal(empty.rangeCalls.length, 0);
  assert.equal(empty.legacyCalls.length, 0);

  for (const size of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const invalid = createFakeService({
      stat: () => fileStat(size),
    });
    await assert.rejects(
      readImagePreviewBlob({
        fileService: invalid.service,
        path: "/work/image.png",
        mediaType: "image/png",
      }),
      expectImagePreviewError("invalid-size"),
    );
    assert.equal(invalid.rangeCalls.length, 0);
    assert.equal(invalid.legacyCalls.length, 0);
  }
});

test("空块、短读、超读均拒绝且不拼出半张图", async () => {
  const cases: Array<[string, () => Uint8Array]> = [
    ["empty-chunk", () => new Uint8Array(0)],
    ["short-read", () => new Uint8Array(2)],
    ["oversized-read", () => new Uint8Array(4)],
  ];

  for (const [code, read] of cases) {
    const fake = createFakeService({
      stat: () => fileStat(3),
      readFileRange: read,
    });
    await assert.rejects(
      readImagePreviewBlob({
        fileService: fake.service,
        path: "/work/image.png",
        mediaType: "image/png",
      }),
      expectImagePreviewError(code),
    );
    assert.equal(fake.rangeCalls.length, 1);
    assert.equal(fake.legacyCalls.length, 0);
  }
});

test("结束 stat 尺寸变化拒绝，尺寸消失按变化处理", async () => {
  const changed = createFakeService({
    stat: (call) => fileStat(call === 1 ? 5 : 4),
    readFileRange: ({ length }) => new Uint8Array(length),
  });
  await assert.rejects(
    readImagePreviewBlob({
      fileService: changed.service,
      path: "/work/image.png",
      mediaType: "image/png",
    }),
    expectImagePreviewError("size-changed"),
  );

  const missingSize = createFakeService({
    stat: (call) => fileStat(call === 1 ? 5 : undefined),
    readFileRange: ({ length }) => new Uint8Array(length),
  });
  await assert.rejects(
    readImagePreviewBlob({
      fileService: missingSize.service,
      path: "/work/image.png",
      mediaType: "image/png",
    }),
    expectImagePreviewError("size-changed"),
  );
});

test("结束前文件消失保留原始错误，现有 missing 判断可识别", async () => {
  const missing = Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
  const fake = createFakeService({
    stat: (call) => {
      if (call === 1) return fileStat(5);
      throw missing;
    },
    readFileRange: ({ length }) => new Uint8Array(length),
  });

  let caught: unknown;
  try {
    await readImagePreviewBlob({
      fileService: fake.service,
      path: "/work/image.png",
      mediaType: "image/png",
    });
  } catch (error) {
    caught = error;
  }
  assert.equal(caught, missing);
  assert.equal(isMissingFileError(caught), true);
});

test("中止后不再追加 range，迟到块不创建 Blob", async () => {
  const controller = new AbortController();
  let rangeCalls = 0;
  const fake = createFakeService({
    stat: () => fileStat(3 * MiB),
    readFileRange: ({ length }) => {
      rangeCalls += 1;
      // 模拟 RPC 在途时用户切换文件：块随后到达，但不能再发下一块。
      controller.abort();
      return new Uint8Array(length);
    },
  });

  const blob = await readImagePreviewBlob({
    fileService: fake.service,
    path: "/work/image.png",
    mediaType: "image/png",
    signal: controller.signal,
  });

  assert.equal(blob, null);
  assert.equal(rangeCalls, 1);
  assert.equal(fake.statCalls(), 1);
});

test("已中止的信号不发起 stat", async () => {
  const controller = new AbortController();
  controller.abort();
  const fake = createFakeService({
    stat: () => fileStat(1),
  });

  const blob = await readImagePreviewBlob({
    fileService: fake.service,
    path: "/work/image.png",
    mediaType: "image/png",
    signal: controller.signal,
  });

  assert.equal(blob, null);
  assert.equal(fake.statCalls(), 0);
  assert.equal(fake.rangeCalls.length, 0);
});

test("仅无 size 的旧服务回退 readMediaPreview，并复用 base64 解码", async () => {
  const data = deterministicBytes(3 * MiB + 17, 31);
  const fake = createFakeService({
    stat: () => fileStat(undefined),
    readFileRange: () => {
      throw new Error("modern path must not run without size");
    },
    readMediaPreview: async ({ path }) => ({
      path,
      mediaType: "image/png",
      dataBase64: Buffer.from(data).toString("base64"),
      totalBytes: data.length,
    }),
  });

  const blob = await readImagePreviewBlob({
    fileService: fake.service,
    path: "/work/image.png",
    mediaType: "image/png",
  });

  assert.ok(blob);
  assert.equal(blob.size, data.length);
  assert.equal(blob.type, "image/png");
  assert.equal(
    await sha256OfBlob(blob),
    createHash("sha256").update(Buffer.from(data)).digest("hex"),
  );
  assert.deepEqual(fake.legacyCalls, [{ path: "/work/image.png" }]);
  assert.equal(fake.rangeCalls.length, 0);
});

test("现代路径读取失败不会回退 base64，原始错误直接保留", async () => {
  const readError = Object.assign(new Error("range read failed"), { code: "EIO" });
  const fake = createFakeService({
    stat: () => fileStat(5),
    readFileRange: () => {
      throw readError;
    },
  });

  let caught: unknown;
  try {
    await readImagePreviewBlob({
      fileService: fake.service,
      path: "/work/image.png",
      mediaType: "image/png",
    });
  } catch (error) {
    caught = error;
  }
  assert.equal(caught, readError);
  assert.equal(fake.legacyCalls.length, 0);
});

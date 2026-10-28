import assert from "node:assert/strict";
import test from "node:test";
import type { CodeViewerWorkspaceScope } from "../src/lib/codeViewerWorkspaceScope.js";
import {
  ImagePreviewLoadController,
  type ImagePreviewLoadSource,
} from "../src/lib/imagePreviewLoadController.js";
import type { ImagePreviewFileService } from "../src/lib/imagePreviewData.js";

interface PendingRead {
  params: ImagePreviewLoadSource & { signal?: AbortSignal };
  resolve: (blob: Blob | null) => void;
  reject: (error: unknown) => void;
}

interface Harness {
  controller: ImagePreviewLoadController;
  pending: PendingRead[];
  created: string[];
  revoked: string[];
  diagnostics: Array<{ path: string; error: unknown }>;
}

function createHarness(): Harness {
  const pending: PendingRead[] = [];
  const created: string[] = [];
  const revoked: string[] = [];
  const diagnostics: Array<{ path: string; error: unknown }> = [];
  let urlCounter = 0;

  const controller = new ImagePreviewLoadController({
    readImagePreviewBlob: (params) =>
      new Promise<Blob | null>((resolve, reject) => {
        pending.push({ params, resolve, reject });
      }),
    isMissingFileError: (error) =>
      (error as { code?: string } | null)?.code === "ENOENT" ||
      /ENOENT|no such file/i.test(error instanceof Error ? error.message : String(error)),
    isTooLargeError: (error) => (error as { code?: string } | null)?.code === "too-large",
    createObjectUrl: () => {
      const url = `blob:mock-${++urlCounter}`;
      created.push(url);
      return url;
    },
    revokeObjectUrl: (url) => {
      revoked.push(url);
    },
    onError: ({ path, error }) => {
      diagnostics.push({ path, error });
    },
  });

  return { controller, pending, created, revoked, diagnostics };
}

function source(
  path: string,
  fileService: object = {},
  scope: CodeViewerWorkspaceScope = {},
): ImagePreviewLoadSource {
  return {
    fileService: fileService as ImagePreviewFileService,
    path,
    mediaType: "image/png",
    ...scope,
  };
}

function imageBlob(): Blob {
  return new Blob(["image-bytes"], { type: "image/png" });
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("成功读取后创建 blob URL 并结束 loading", async () => {
  const harness = createHarness();

  harness.controller.setSource(source("/workspace/shot.png"));
  assert.deepEqual(harness.controller.getState(), {
    url: null,
    loading: true,
    errorKind: null,
  });

  harness.pending[0].resolve(imageBlob());
  await flush();

  assert.deepEqual(harness.controller.getState(), {
    url: "blob:mock-1",
    loading: false,
    errorKind: null,
  });
  assert.deepEqual(harness.created, ["blob:mock-1"]);
  assert.deepEqual(harness.revoked, []);
  assert.deepEqual(harness.diagnostics, []);
});

test("换源会中止旧任务并撤销已展示的 URL", async () => {
  const harness = createHarness();
  const service = {};

  harness.controller.setSource(source("/workspace/a.png", service));
  harness.pending[0].resolve(imageBlob());
  await flush();
  assert.equal(harness.controller.getState().url, "blob:mock-1");

  harness.controller.setSource(source("/workspace/b.png", service));
  assert.equal(harness.pending[0].params.signal?.aborted, true);
  assert.deepEqual(harness.revoked, ["blob:mock-1"]);
  assert.deepEqual(harness.controller.getState(), {
    url: null,
    loading: true,
    errorKind: null,
  });

  harness.pending[1].resolve(imageBlob());
  await flush();
  assert.deepEqual(harness.controller.getState(), {
    url: "blob:mock-2",
    loading: false,
    errorKind: null,
  });
});

test("读取中切换来源：旧请求被 abort，迟到 resolve 不提交 URL / loading", async () => {
  const harness = createHarness();
  const service = {};

  harness.controller.setSource(source("/workspace/a.png", service));
  const first = harness.pending[0];
  harness.controller.setSource(source("/workspace/b.png", service));
  assert.equal(first.params.signal?.aborted, true);

  first.resolve(imageBlob());
  await flush();
  assert.deepEqual(harness.created, []);
  assert.deepEqual(harness.controller.getState(), {
    url: null,
    loading: true,
    errorKind: null,
  });

  harness.pending[1].resolve(imageBlob());
  await flush();
  assert.equal(harness.controller.getState().url, "blob:mock-1");
  assert.equal(harness.controller.getState().loading, false);
});

test("读取中切换来源：旧请求迟到 reject 不写错误、不结束新 loading", async () => {
  const harness = createHarness();
  const service = {};

  harness.controller.setSource(source("/workspace/a.png", service));
  const first = harness.pending[0];
  harness.controller.setSource(source("/workspace/b.png", service));

  first.reject(new Error("late failure"));
  await flush();
  assert.deepEqual(harness.diagnostics, []);
  assert.deepEqual(harness.controller.getState(), {
    url: null,
    loading: true,
    errorKind: null,
  });
});

test("取消 / 卸载停止读取并清空 loading，迟到结果不提交", async () => {
  const harness = createHarness();

  harness.controller.setSource(source("/workspace/a.png"));
  const first = harness.pending[0];
  harness.controller.setSource(null);

  assert.equal(first.params.signal?.aborted, true);
  assert.deepEqual(harness.controller.getState(), {
    url: null,
    loading: false,
    errorKind: null,
  });

  first.resolve(imageBlob());
  await flush();
  assert.deepEqual(harness.created, []);
  assert.deepEqual(harness.controller.getState(), {
    url: null,
    loading: false,
    errorKind: null,
  });
});

test("关闭已加载图片会撤销 URL", async () => {
  const harness = createHarness();

  harness.controller.setSource(source("/workspace/a.png"));
  harness.pending[0].resolve(imageBlob());
  await flush();
  assert.equal(harness.controller.getState().url, "blob:mock-1");

  harness.controller.setSource(null);
  assert.deepEqual(harness.revoked, ["blob:mock-1"]);
  assert.deepEqual(harness.controller.getState(), {
    url: null,
    loading: false,
    errorKind: null,
  });
});

test("错误结束 loading 并按 missing / too-large / unavailable 分类", async () => {
  const harness = createHarness();

  harness.controller.setSource(source("/workspace/missing.png"));
  harness.pending[0].reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
  await flush();
  assert.deepEqual(harness.controller.getState(), {
    url: null,
    loading: false,
    errorKind: "missing",
  });

  harness.controller.setSource(source("/workspace/too-large.png"));
  harness.pending[1].reject(Object.assign(new Error("image too large"), { code: "too-large" }));
  await flush();
  assert.deepEqual(harness.controller.getState(), {
    url: null,
    loading: false,
    errorKind: "too-large",
  });

  harness.controller.setSource(source("/workspace/broken.png"));
  harness.pending[2].reject(new Error("decode failed"));
  await flush();
  assert.deepEqual(harness.controller.getState(), {
    url: null,
    loading: false,
    errorKind: "unavailable",
  });

  // 原始绝对路径只进入诊断回调，不进入可渲染状态。
  assert.deepEqual(
    harness.diagnostics.map((entry) => entry.path),
    ["/workspace/missing.png", "/workspace/too-large.png", "/workspace/broken.png"],
  );
  assert.equal(JSON.stringify(harness.controller.getState()).includes("/workspace/"), false);
});

test("同一路径和服务不重复读取；换服务对象重新读取并路由到新服务", async () => {
  const harness = createHarness();
  const service = {};
  const nextService = {};

  harness.controller.setSource(source("/workspace/a.png", service));
  harness.controller.setSource(source("/workspace/a.png", service));
  assert.equal(harness.pending.length, 1);
  assert.equal(harness.pending[0].params.fileService, service);

  harness.pending[0].resolve(imageBlob());
  await flush();

  harness.controller.setSource(source("/workspace/a.png", nextService));
  assert.equal(harness.pending.length, 2);
  assert.equal(harness.pending[1].params.fileService, nextService);
  assert.deepEqual(harness.revoked, ["blob:mock-1"]);
  assert.equal(harness.controller.getState().loading, true);
});

test("同一服务同绝对路径：workspace identity 优先于 path，身份变化重读", async () => {
  const harness = createHarness();
  const service = {};

  harness.controller.setSource(
    source("/shared/photo.png", service, {
      workspacePath: "/workspace/one",
      workspaceIdentity: "identity-1",
    }),
  );
  harness.pending[0].resolve(imageBlob());
  await flush();

  // identity 相同、path 不同：仍视为同一 workspace，不重复读取。
  harness.controller.setSource(
    source("/shared/photo.png", service, {
      workspacePath: "/workspace/two",
      workspaceIdentity: "identity-1",
    }),
  );
  assert.equal(harness.pending.length, 1);

  // 同一服务、同一绝对路径，仅 identity 变化：必须撤销并重读。
  harness.controller.setSource(
    source("/shared/photo.png", service, {
      workspacePath: "/workspace/two",
      workspaceIdentity: "identity-2",
    }),
  );
  assert.equal(harness.pending.length, 2);
  assert.deepEqual(harness.revoked, ["blob:mock-1"]);
  assert.equal(harness.pending[1].params.workspaceIdentity, "identity-2");
});

test("同一服务同路径：remote session 变化必须重读", async () => {
  const harness = createHarness();
  const service = {};

  harness.controller.setSource(
    source("/shared/photo.png", service, {
      workspacePath: "/workspace",
      workspaceRemoteSessionId: "session-1",
    }),
  );
  harness.pending[0].resolve(imageBlob());
  await flush();

  harness.controller.setSource(
    source("/shared/photo.png", service, {
      workspacePath: "/workspace",
      workspaceRemoteSessionId: "session-2",
    }),
  );
  assert.equal(harness.pending.length, 2);
  assert.deepEqual(harness.revoked, ["blob:mock-1"]);
  assert.equal(harness.pending[1].params.workspaceRemoteSessionId, "session-2");
});

test("没有 workspace identity 时按 workspacePath 区分", async () => {
  const harness = createHarness();
  const service = {};

  harness.controller.setSource(
    source("/shared/photo.png", service, { workspacePath: "/workspace/one" }),
  );
  harness.pending[0].resolve(imageBlob());
  await flush();

  harness.controller.setSource(
    source("/shared/photo.png", service, { workspacePath: "/workspace/two" }),
  );
  assert.equal(harness.pending.length, 2);
  assert.deepEqual(harness.revoked, ["blob:mock-1"]);
});

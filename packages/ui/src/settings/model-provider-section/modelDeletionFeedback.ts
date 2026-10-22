export interface ModelDeletionFeedbackEntry {
  readonly key: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly state: "pending" | "success" | "failure";
  readonly error?: string;
}

export interface ModelDeletionFeedbackInput {
  providerId: string;
  modelId: string;
  operation: () => Promise<unknown>;
}

export interface ModelDeletionFeedbackController {
  getSnapshot(): readonly ModelDeletionFeedbackEntry[];
  subscribe(listener: () => void): () => void;
  run(input: ModelDeletionFeedbackInput): Promise<void>;
  observeModels(providerId: string, modelIds: readonly string[]): void;
  retry(key: string): Promise<void>;
  dismiss(): void;
  dispose(): void;
}

interface FeedbackRecord {
  entry: ModelDeletionFeedbackEntry;
  operation?: ModelDeletionFeedbackInput["operation"];
  promise?: Promise<void>;
  observedAbsent: boolean;
  observedReappearance: boolean;
}

export function createModelDeletionFeedbackController(): ModelDeletionFeedbackController {
  const records = new Map<string, FeedbackRecord>();
  const listeners = new Set<() => void>();
  let snapshot: readonly ModelDeletionFeedbackEntry[] = [];
  let disposed = false;

  const publish = () => {
    snapshot = [...records.values()].map((record) => record.entry);
    // 订阅回调可能重入增删订阅，本次发布只遍历发布开始时的监听者。
    const currentListeners = [...listeners];
    for (const listener of currentListeners) listener();
  };

  const run = (input: ModelDeletionFeedbackInput): Promise<void> => {
    if (disposed) return Promise.resolve();
    const key = JSON.stringify([input.providerId, input.modelId]);
    const existing = records.get(key);
    if (existing?.promise) return existing.promise;
    if (existing?.entry.state === "success" && !existing.observedReappearance) {
      return Promise.resolve();
    }

    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    const record: FeedbackRecord = {
      entry: { key, providerId: input.providerId, modelId: input.modelId, state: "pending" },
      operation: input.operation,
      promise,
      observedAbsent: false,
      observedReappearance: false,
    };
    // 删除结果属于自身请求，不能被另一个模型或表单草稿 revision 丢弃而永久停在 pending。
    // 先登记 promise 再发布快照及执行操作，订阅或 operation 重入时仍复用同一次提交。
    records.set(key, record);
    publish();

    const complete = (state: "success" | "failure", error?: unknown) => {
      if (disposed || records.get(key) !== record) return;
      record.promise = undefined;
      record.entry = {
        key,
        providerId: input.providerId,
        modelId: input.modelId,
        state,
        ...(state === "failure"
          ? { error: error instanceof Error ? error.message : String(error) }
          : {}),
      };
      if (state === "success") record.operation = undefined;
      publish();
    };

    void Promise.resolve()
      .then(input.operation)
      .then(
        () => {
          complete("success");
          resolve();
        },
        (error: unknown) => {
          complete("failure", error);
          reject(error);
        },
      );
    return promise;
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      if (disposed) return () => undefined;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    run,
    observeModels: (providerId, modelIds) => {
      if (disposed) return;
      const currentIds = new Set(modelIds);
      for (const record of records.values()) {
        if (record.entry.providerId !== providerId) continue;
        // 删除的权威事件可能先于 RPC 完成；从 pending 起记录消失与重现，
        // 既阻止旧列表重复提交，也允许用户重新添加同 ID 后再次删除。
        if (!currentIds.has(record.entry.modelId)) record.observedAbsent = true;
        else if (record.observedAbsent) record.observedReappearance = true;
      }
    },
    retry: (key) => {
      const record = records.get(key);
      if (record?.promise) return record.promise;
      if (record?.entry.state !== "failure" || !record.operation) return Promise.resolve();
      return run({
        providerId: record.entry.providerId,
        modelId: record.entry.modelId,
        operation: record.operation,
      });
    },
    dismiss: () => {
      if (
        disposed ||
        records.size === 0 ||
        [...records.values()].some((record) => record.promise)
      ) {
        return;
      }
      records.clear();
      publish();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      records.clear();
      listeners.clear();
      snapshot = [];
    },
  };
}

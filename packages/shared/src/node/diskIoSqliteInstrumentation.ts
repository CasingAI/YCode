import { performance } from "node:perf_hooks";
import {
  sqlite,
  replaceMethod,
  type DiskIoRecorder,
} from "./diskIoInstrumentationShared.js";

export function installDiskIoSqlitePatches(tracker: DiskIoRecorder): void {
  replaceMethod(sqlite.DatabaseSync.prototype, "exec", (original) => function (this: unknown, ...args: unknown[]) {
    const startedAt = performance.now();
    try {
      const result = original.apply(this, args);
      tracker.record("sqlite", "database", performance.now() - startedAt, null, false);
      return result;
    } catch (error) {
      tracker.record("sqlite", "database", performance.now() - startedAt, null, true);
      throw error;
    }
  });
  replaceMethod(sqlite.DatabaseSync.prototype, "prepare", (original) => function (this: unknown, ...args: unknown[]) {
    const startedAt = performance.now();
    try {
      return original.apply(this, args);
    } catch (error) {
      tracker.record("sqlite", "database", performance.now() - startedAt, null, true);
      throw error;
    }
  });
  for (const name of ["get", "all", "run"] as const) {
    replaceMethod(sqlite.StatementSync.prototype, name, (original) => function (this: unknown, ...args: unknown[]) {
      const startedAt = performance.now();
      try {
        const result = original.apply(this, args);
        tracker.record("sqlite", "database", performance.now() - startedAt, null, false);
        return result;
      } catch (error) {
        tracker.record("sqlite", "database", performance.now() - startedAt, null, true);
        throw error;
      }
    });
  }
  replaceMethod(sqlite.StatementSync.prototype, "iterate", (original) => function (this: unknown, ...args: unknown[]) {
    const startedAt = performance.now();
    let iterator: unknown;
    try {
      iterator = original.apply(this, args);
    } catch (error) {
      tracker.record("sqlite", "database", performance.now() - startedAt, null, true);
      throw error;
    }
    if (!iterator || typeof iterator !== "object" || !("next" in iterator)) {
      tracker.record("sqlite", "database", performance.now() - startedAt, null, false);
      return iterator;
    }
    let finalized = false;
    const finish = (failed: boolean) => {
      if (finalized) return;
      finalized = true;
      tracker.record("sqlite", "database", performance.now() - startedAt, null, failed);
    };
    const source = iterator as {
      next: (...values: unknown[]) => unknown;
      return?: (...values: unknown[]) => unknown;
      [Symbol.iterator]?: () => unknown;
    };
    const wrapped = {
      next(...nextArgs: unknown[]) {
        try {
          const result = source.next(...nextArgs) as { done?: boolean };
          if (result?.done) finish(false);
          return result;
        } catch (error) {
          finish(true);
          throw error;
        }
      },
      return(...returnArgs: unknown[]) {
        try {
          const result = source.return?.(...returnArgs) ?? { done: true, value: undefined };
          finish(false);
          return result;
        } catch (error) {
          finish(true);
          throw error;
        }
      },
      [Symbol.iterator]() { return this; },
    };
    return wrapped;
  });
}

import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import {
  byteLength,
  classifyDiskIoModule,
  encodingFromOptions,
  fileDescriptorModules,
  fileHandleModules,
  fs,
  fsPromises,
  patchFileHandlePrototype,
  pathHint,
  readNumericField,
  replaceExport,
  streamFileDescriptors,
  type DiskIoRecorder,
  type Method,
} from "./diskIoInstrumentationShared.js";

export function installDiskIoFilePatches(tracker: DiskIoRecorder): void {
  // appendFileSync may delegate to writeFileSync internally; count the outer public operation once.
  let synchronousFileOperationDepth = 0;
  // Keep nested callback-based high-level APIs from double-counting their underlying fd operations.
  const callbackFileOperationContext = new AsyncLocalStorage<boolean>();
  const wrapSync = (name: string, kind: "read" | "write") => {
    replaceExport(fs, name, (original) => function (this: unknown, ...args: unknown[]) {
      const shouldRecord = synchronousFileOperationDepth === 0;
      synchronousFileOperationDepth += 1;
      const module = classifyDiskIoModule(pathHint(args[0]));
      const startedAt = performance.now();
      try {
        const result = original.apply(this, args);
        if (shouldRecord) {
          const bytes = kind === "read"
            ? byteLength(result, encodingFromOptions(args[1]))
            : byteLength(args[1], encodingFromOptions(args[2]));
          tracker.record(module, kind, performance.now() - startedAt, bytes, false);
        }
        return result;
      } catch (error) {
        if (shouldRecord) tracker.record(module, kind, performance.now() - startedAt, null, true);
        throw error;
      } finally {
        synchronousFileOperationDepth -= 1;
      }
    });
  };
  wrapSync("readFileSync", "read");
  wrapSync("writeFileSync", "write");
  wrapSync("appendFileSync", "write");

  const wrapPromise = (name: string, kind: "read" | "write") => {
    replaceExport(fsPromises, name, (original) => function (this: unknown, ...args: unknown[]) {
      const module = classifyDiskIoModule(pathHint(args[0]));
      const startedAt = performance.now();
      return Promise.resolve(original.apply(this, args)).then(
        (result) => {
          const bytes = kind === "read"
            ? byteLength(result, encodingFromOptions(args[1]))
            : byteLength(args[1], encodingFromOptions(args[2]));
          tracker.record(module, kind, performance.now() - startedAt, bytes, false);
          return result;
        },
        (error: unknown) => {
          tracker.record(module, kind, performance.now() - startedAt, null, true);
          throw error;
        },
      );
    });
  };
  wrapPromise("readFile", "read");
  wrapPromise("writeFile", "write");
  wrapPromise("appendFile", "write");

  const wrapCallback = (name: string, kind: "read" | "write") => {
    replaceExport(fs, name, (original) => function (this: unknown, ...args: unknown[]) {
      const callbackIndex = args.length - 1;
      const callback = args[callbackIndex];
      if (typeof callback !== "function") return original.apply(this, args);
      const module = classifyDiskIoModule(pathHint(args[0]));
      const startedAt = performance.now();
      const shouldRecord = callbackFileOperationContext.getStore() !== true;
      args[callbackIndex] = function (this: unknown, ...callbackArgs: unknown[]) {
        if (shouldRecord) {
          const error = callbackArgs[0];
          const result = callbackArgs[1];
          const bytes = error
            ? null
            : kind === "read"
              ? byteLength(result, encodingFromOptions(args[1]))
              : byteLength(args[1], encodingFromOptions(args[2]));
          tracker.record(module, kind, performance.now() - startedAt, bytes, Boolean(error));
        }
        return callbackFileOperationContext.run(false, () =>
          (callback as (...values: unknown[]) => unknown).apply(this, callbackArgs),
        );
      };
      return callbackFileOperationContext.run(true, () => original.apply(this, args));
    });
  };
  wrapCallback("readFile", "read");
  wrapCallback("writeFile", "write");
  wrapCallback("appendFile", "write");

  const wrapCopy = (target: Record<string, unknown>, name: string, callbackStyle: boolean, sync: boolean) => {
    replaceExport(target, name, (original) => function (this: unknown, ...args: unknown[]) {
      const sourceModule = classifyDiskIoModule(pathHint(args[0]));
      const destinationModule = classifyDiskIoModule(pathHint(args[1]));
      const startedAt = performance.now();
      const finish = (failed: boolean) => {
        const duration = performance.now() - startedAt;
        tracker.record(sourceModule, "read", duration, null, failed);
        tracker.record(destinationModule, "write", duration, null, failed);
      };
      if (callbackStyle) {
        const callbackIndex = args.length - 1;
        const callback = args[callbackIndex];
        if (typeof callback !== "function") return original.apply(this, args);
        args[callbackIndex] = function (this: unknown, ...callbackArgs: unknown[]) {
          finish(Boolean(callbackArgs[0]));
          return (callback as (...values: unknown[]) => unknown).apply(this, callbackArgs);
        };
        return original.apply(this, args);
      }
      if (sync) {
        try {
          const result = original.apply(this, args);
          finish(false);
          return result;
        } catch (error) {
          finish(true);
          throw error;
        }
      }
      return Promise.resolve(original.apply(this, args)).then(
        (result) => { finish(false); return result; },
        (error: unknown) => { finish(true); throw error; },
      );
    });
  };
  wrapCopy(fs, "copyFileSync", false, true);
  wrapCopy(fs, "copyFile", true, false);
  wrapCopy(fsPromises, "copyFile", false, false);

  const wrapOpenSync = fs.openSync as Method | undefined;
  if (typeof wrapOpenSync === "function") {
    replaceExport(fs, "openSync", (original) => function (this: unknown, ...args: unknown[]) {
      const fd = original.apply(this, args);
      if (typeof fd === "number") {
        const path = pathHint(args[0]);
        if (path) fileDescriptorModules.set(fd, classifyDiskIoModule(path));
      }
      return fd;
    });
  }
  replaceExport(fs, "open", (original) => function (this: unknown, ...args: unknown[]) {
    const callbackIndex = args.length - 1;
    const callback = args[callbackIndex];
    if (typeof callback !== "function") return original.apply(this, args);
    const module = classifyDiskIoModule(pathHint(args[0]));
    args[callbackIndex] = function (this: unknown, ...callbackArgs: unknown[]) {
      const error = callbackArgs[0];
      const fd = callbackArgs[1];
      if (!error && typeof fd === "number") fileDescriptorModules.set(fd, module);
      return (callback as (...values: unknown[]) => unknown).apply(this, callbackArgs);
    };
    return original.apply(this, args);
  });
  const removeFd = (fd: unknown) => {
    if (typeof fd === "number") fileDescriptorModules.delete(fd);
  };
  replaceExport(fs, "closeSync", (original) => function (this: unknown, ...args: unknown[]) {
    try { return original.apply(this, args); } finally { removeFd(args[0]); }
  });
  replaceExport(fs, "close", (original) => function (this: unknown, ...args: unknown[]) {
    const callbackIndex = args.length - 1;
    const callback = args[callbackIndex];
    if (typeof callback !== "function") return original.apply(this, args);
    args[callbackIndex] = function (this: unknown, ...callbackArgs: unknown[]) {
      removeFd(args[0]);
      return (callback as (...values: unknown[]) => unknown).apply(this, callbackArgs);
    };
    return original.apply(this, args);
  });

  const wrapFdIo = (name: string, kind: "read" | "write", callbackStyle: boolean, sync: boolean) => {
    replaceExport(fs, name, (original) => function (this: unknown, ...args: unknown[]) {
      if (
        synchronousFileOperationDepth > 0 || callbackFileOperationContext.getStore() === true
      ) {
        return original.apply(this, args);
      }
      const fd = Number(args[0]);
      if (streamFileDescriptors.has(fd)) return original.apply(this, args);
      const module = fileDescriptorModules.get(fd);
      if (!module) return original.apply(this, args);
      const startedAt = performance.now();
      const measure = (error: unknown, result: unknown) => {
        const bytes = error
          ? null
          : typeof result === "number"
            ? result
            : readNumericField(result, kind === "read" ? "bytesRead" : "bytesWritten");
        tracker.record(module, kind, performance.now() - startedAt, bytes, Boolean(error));
      };
      if (sync) {
        try {
          const result = original.apply(this, args);
          measure(null, result);
          return result;
        } catch (error) {
          measure(error, null);
          throw error;
        }
      }
      if (callbackStyle) {
        const callbackIndex = args.length - 1;
        const callback = args[callbackIndex];
        if (typeof callback !== "function") return original.apply(this, args);
        args[callbackIndex] = function (this: unknown, ...callbackArgs: unknown[]) {
          measure(callbackArgs[0], callbackArgs[1]);
          return (callback as (...values: unknown[]) => unknown).apply(this, callbackArgs);
        };
        return original.apply(this, args);
      }
      return Promise.resolve(original.apply(this, args)).then(
        (result) => { measure(null, result); return result; },
        (error: unknown) => { measure(error, null); throw error; },
      );
    });
  };
  wrapFdIo("readSync", "read", false, true);
  wrapFdIo("writeSync", "write", false, true);
  wrapFdIo("read", "read", true, false);
  wrapFdIo("write", "write", true, false);
  wrapFdIo("readv", "read", true, false);
  wrapFdIo("writev", "write", true, false);

  const wrapStream = (name: string, kind: "read" | "write") => {
    replaceExport(fs, name, (original) => function (this: unknown, ...args: unknown[]) {
      const streamOptions = args[1];
      const path = pathHint(args[0]);
      const descriptor =
        typeof streamOptions === "object" && streamOptions !== null && "fd" in streamOptions
          ? (streamOptions as { fd?: unknown }).fd
          : undefined;
      const module = path
        ? classifyDiskIoModule(path)
        : typeof descriptor === "number"
          ? fileDescriptorModules.get(descriptor) ?? "filesystem"
          : "filesystem";
      const startedAt = performance.now();
      const stream = original.apply(this, args) as {
        once(event: string, listener: (...values: unknown[]) => void): unknown;
        bytesRead?: number;
        bytesWritten?: number;
        fd?: number;
      };
      let finalized = false;
      // A caller-supplied fd does not emit "open"; suppress its underlying operations immediately.
      let streamFd: number | undefined = typeof descriptor === "number" ? descriptor : undefined;
      if (streamFd !== undefined) streamFileDescriptors.add(streamFd);
      const finalize = (failed: boolean) => {
        if (finalized) return;
        finalized = true;
        if (streamFd !== undefined) streamFileDescriptors.delete(streamFd);
        const bytes = kind === "read" ? stream.bytesRead : stream.bytesWritten;
        tracker.record(module, kind, performance.now() - startedAt,
          typeof bytes === "number" && Number.isFinite(bytes) ? bytes : null, failed);
      };
      stream.once("open", (fd: unknown) => {
        if (typeof fd === "number") {
          if (streamFd !== undefined && streamFd !== fd) streamFileDescriptors.delete(streamFd);
          streamFd = fd;
          streamFileDescriptors.add(fd);
        }
      });
      stream.once(kind === "read" ? "end" : "finish", () => finalize(false));
      stream.once("error", () => finalize(true));
      stream.once("close", () => finalize(false));
      return stream;
    });
  };
  wrapStream("createReadStream", "read");
  wrapStream("createWriteStream", "write");

  replaceExport(fsPromises, "open", (original) => function (this: unknown, ...args: unknown[]) {
    const module = classifyDiskIoModule(pathHint(args[0]));
    return Promise.resolve(original.apply(this, args)).then((handle) => {
      if (handle && typeof handle === "object") {
        fileHandleModules.set(handle, module);
        patchFileHandlePrototype(Object.getPrototypeOf(handle) as object, tracker);
      }
      return handle;
    });
  });
}

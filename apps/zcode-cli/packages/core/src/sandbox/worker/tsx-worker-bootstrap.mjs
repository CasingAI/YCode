// 测试/tsx 源文件模式的 Worker 引导：Node 的 Worker 不会自动沿用主线程的
// tsx 加载器（tsx preflight 只注册主线程），这里在 Worker 内显式注册后再加载
// TypeScript 入口。生产产物用 sandbox-worker.cjs，不经过本文件。
import { register } from "tsx/esm/api";

register();
await import("./sandbox-worker-entry.ts");

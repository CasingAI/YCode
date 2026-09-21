import { z } from "zod";

// 该 schema 同时被 validation 聚合入口和 legacy protocol 使用，必须放在无反向依赖的叶子模块。
// 根因：protocol 从 validation 导入它，而 validation 又导入 protocol 的资源采样 schema，
// ESM/Jiti 在 clean Docker 中会先读到尚未初始化的 binding，导致 `.optional()` 启动即崩溃。
// 权限轴已收敛为 plan / readonly / yolo；build / edit / auto / autoEdit 只作为升级前落盘数据的读取兼容值。
export const zcodeTaskModeSchema = z.enum([
  "yolo",
  "plan",
  "readonly",
  "edit",
  "auto",
  "autoEdit",
  "build",
]);

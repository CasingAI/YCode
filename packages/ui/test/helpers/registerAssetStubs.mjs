/**
 * 注册资源 stub loader（见 assetStubHook.mjs）。
 *
 * 单独成文件是因为 `--import` 需要一个 URL，`--import ./hook.mjs` 只会注册模块本身而不会
 * 执行其中的 `register()`。
 */
import { register } from "node:module";

register("./assetStubHook.mjs", import.meta.url);

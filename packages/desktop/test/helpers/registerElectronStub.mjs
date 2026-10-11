/**
 * 注册 electron 桩 loader（见 electronStubHook.mjs）。
 *
 * 用法：`pnpm exec tsx --import ./test/helpers/registerElectronStub.mjs --test <file>`
 */
import { register } from "node:module";

register("./electronStubHook.mjs", import.meta.url);

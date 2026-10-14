import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import test from "node:test";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Logo 资产静态完整性（不用 import 模块：tsx 加载不了 .png/.mp3 资产，见
// cliproxyCreationDisabled 的既有失败）。直接解析 providerLogoAssets.ts 源码：
// 1) 每个 import 的素材文件必须真实存在；
// 2) 每个注册键引用的标识符必须能对应到已导入素材；
// 3) CLI Proxy 渠道键（gemini/antigravity）必须已注册。

const sectionDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../src/settings/model-provider-section",
);
const source = readFileSync(join(sectionDir, "providerLogoAssets.ts"), "utf8");
const iconsDir = resolve(sectionDir, "../../assets/provider-icons");

test("providerIcons 目录下所有被 import 的素材文件都存在", () => {
  const imports = [...source.matchAll(/@\/assets\/provider-icons\/([\w./-]+)"/g)].map(
    (match) => match[1],
  );
  assert.ok(imports.length >= 10, `应解析到素材导入（实际 ${imports.length}）`);
  const missing = imports.filter((file) => !existsSync(resolve(iconsDir, file)));
  assert.deepEqual(missing, [], `缺失素材: ${missing.join(", ")}`);
});

test("CLI Proxy 渠道键（gemini/antigravity）已注册且素材存在", () => {
  const varToFile = new Map(
    [...source.matchAll(/import (\w+) from "@\/assets\/provider-icons\/([\w./-]+)"/g)].map(
      (match) => [match[1], match[2]],
    ),
  );
  for (const key of ["gemini", "antigravity"]) {
    const entry = new RegExp(`"?${key}"?:\\s*\\{\\s*light:\\s*(\\w+)`).exec(source);
    assert.ok(entry, `注册表缺少键 "${key}"`);
    const file = varToFile.get(entry[1]);
    assert.ok(file, `键 "${key}" 的素材标识符 ${entry[1]} 未对应到 import`);
    assert.ok(
      existsSync(resolve(iconsDir, file)),
      `键 "${key}" 的素材文件不存在: ${file}`,
    );
  }
});

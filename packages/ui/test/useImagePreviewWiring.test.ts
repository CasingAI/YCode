import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const hookSourceUrl = new URL("../src/hooks/useImagePreview.ts", import.meta.url);

test("useImagePreview 把 workspace 字段写入 source 并纳入 useMemo 依赖", async () => {
  const source = await readFile(hookSourceUrl, "utf8");

  const memoDependencies = source.match(
    /useMemo<ImagePreviewLoadSource \| null>\([\s\S]*?,\s*\[([^\]]+)\]/,
  )?.[1];
  assert.ok(memoDependencies);
  const dependencies = memoDependencies.split(",").map((dependency) => dependency.trim());
  for (const field of ["workspacePath", "workspaceIdentity", "workspaceRemoteSessionId"] as const) {
    assert.match(source, new RegExp(`${field}\\?: string \\| null`));
    assert.match(source, new RegExp(`${field}: ${field} \\?\\? undefined`));
    assert.ok(dependencies.includes(field));
  }

  assert.match(
    source,
    /useEffect\(\(\) => \{\s*controller\.setSource\(source\);\s*return \(\) => \{\s*controller\.setSource\(null\);\s*\};\s*\}, \[controller, source\]\)/,
  );
});

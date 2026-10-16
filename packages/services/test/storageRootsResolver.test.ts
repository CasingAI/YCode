import assert from "node:assert/strict";
import test from "node:test";
import { resolveStorageRoots } from "../src/storage/adapters/rootsResolver.js";

test("storage scan covers both product roots at home and custom data base", () => {
  assert.deepEqual(
    resolveStorageRoots({ homeDir: "/home/user", dataBaseDir: "/data" }).map((root) => [
      root.id,
      root.path,
    ]),
    [
      ["home", "/home/user/.zcode"],
      ["ycodeHome", "/home/user/.ycode"],
      ["dataBaseDir", "/data/.zcode"],
      ["ycodeDataBaseDir", "/data/.ycode"],
    ],
  );
});

test("storage scan does not duplicate product roots when data base is home", () => {
  assert.deepEqual(
    resolveStorageRoots({ homeDir: "/home/user", dataBaseDir: "/home/user" }).map((root) => [
      root.id,
      root.path,
    ]),
    [
      ["home", "/home/user/.zcode"],
      ["ycodeHome", "/home/user/.ycode"],
    ],
  );
});

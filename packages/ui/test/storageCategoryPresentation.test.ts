import assert from "node:assert/strict";
import test from "node:test";
import { STORAGE_CATEGORY_IDS } from "@zcode/shared";
import {
  STORAGE_CATEGORY_ICONS,
  storageCategoryDescriptionId,
  storageCategoryTitleId,
} from "../src/settings/usage-stats/storage/storageCategoryPresentation.js";

test("存储类别展示键覆盖全部目录 ID，工具输出与临时缓存分开", () => {
  for (const id of STORAGE_CATEGORY_IDS) {
    assert.ok(STORAGE_CATEGORY_ICONS[id], `missing icon for ${id}`);
    assert.equal(storageCategoryTitleId(id), `settings.storage.category.${id}`);
    assert.equal(storageCategoryDescriptionId(id), `settings.storage.categoryDescription.${id}`);
  }
  assert.equal(storageCategoryTitleId("toolOutputs"), "settings.storage.category.toolOutputs");
  assert.equal(
    storageCategoryTitleId("temporaryCaches"),
    "settings.storage.category.temporaryCaches",
  );
});

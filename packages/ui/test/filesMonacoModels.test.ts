import assert from "node:assert/strict";
import test from "node:test";
import {
  isWritingFilesMonacoModel,
  writeFilesMonacoModelValue,
} from "../src/files-workbench/filesMonacoModels.js";

test("程序化灌入期间挡住模型回调，避免规范化差异来回写缓冲", () => {
  let version = 0;
  let heardUserChange = 0;
  const model = {
    getValue: () => `v${version}`,
    setValue: () => {
      version += 1;
      if (!isWritingFilesMonacoModel()) {
        heardUserChange += 1;
      }
    },
  };

  assert.equal(model.getValue(), "v0");
  writeFilesMonacoModelValue(model, "wanted");
  assert.equal(heardUserChange, 0);
  assert.equal(isWritingFilesMonacoModel(), false);
  assert.equal(model.getValue(), "v1");
});

test("模型值已与缓冲相同时不写盘、不抬 writing 计数", () => {
  const model = {
    getValue: () => "same",
    setValue: () => {
      throw new Error("相同正文不应再 setValue");
    },
  };
  writeFilesMonacoModelValue(model, "same");
  assert.equal(isWritingFilesMonacoModel(), false);
});

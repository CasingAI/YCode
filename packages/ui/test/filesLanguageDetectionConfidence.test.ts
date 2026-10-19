import assert from "node:assert/strict";
import test from "node:test";
import {
  filesLanguageDetectionAdjustedConfidence,
  filesLanguageDetectionLooksLikeJson,
  filesLanguageDetectionMonacoId,
  FILES_LANGUAGE_DETECTION_THRESHOLD,
  selectFilesDetectedLanguage,
} from "../src/files-workbench/filesLanguageDetectionConfidence.js";

test("模型短标签映射到 Monaco 语言 id", () => {
  assert.equal(filesLanguageDetectionMonacoId("ts"), "typescript");
  assert.equal(filesLanguageDetectionMonacoId("js"), "javascript");
  assert.equal(filesLanguageDetectionMonacoId("py"), "python");
  assert.equal(filesLanguageDetectionMonacoId("yaml"), "yaml");
  assert.equal(filesLanguageDetectionMonacoId("toml"), "ini");
  // 映射不出的标签直接丢弃。
  assert.equal(filesLanguageDetectionMonacoId("hs"), undefined);
  assert.equal(filesLanguageDetectionMonacoId("unknown"), undefined);
});

test("置信度修正表与 VS Code 一致", () => {
  const near = (actual: number, expected: number) =>
    assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
  near(filesLanguageDetectionAdjustedConfidence("json", 0.2), 0.25);
  near(filesLanguageDetectionAdjustedConfidence("ts", 0.2), 0.25);
  near(filesLanguageDetectionAdjustedConfidence("cpp", 0.2), 0.225);
  near(filesLanguageDetectionAdjustedConfidence("toml", 0.6), 0.1);
  // YAML 既不加成也不惩罚。
  near(filesLanguageDetectionAdjustedConfidence("yaml", 0.3), 0.3);
});

test("置信度不足时没有结论", () => {
  assert.equal(selectFilesDetectedLanguage([]), undefined);
  assert.equal(
    selectFilesDetectedLanguage([
      { languageId: "ts", confidence: FILES_LANGUAGE_DETECTION_THRESHOLD - 0.1 },
    ]),
    undefined,
  );
});

test("映射不出 Monaco 的候选被丢弃", () => {
  assert.equal(
    selectFilesDetectedLanguage([
      { languageId: "hs", confidence: 0.9 },
      { languageId: "ts", confidence: 0.3 },
    ]),
    "typescript",
  );
});

test("内容是 JSON 时不让 YAML 抢走", () => {
  // 模型仓库有「JSON 被判成 YAML」的已知报告，这里专门压住该误判。
  const detected = selectFilesDetectedLanguage(
    [
      { languageId: "yaml", confidence: 0.4 },
      { languageId: "json", confidence: 0.35 },
    ],
    '{\n  "name": "demo"\n}\n',
  );
  assert.equal(detected, "json");
});

test("内容不是 JSON 时保留 YAML 结果", () => {
  const detected = selectFilesDetectedLanguage(
    [
      { languageId: "yaml", confidence: 0.4 },
      { languageId: "json", confidence: 0.35 },
    ],
    "name: demo\nversion: 1.0.0\n",
  );
  assert.equal(detected, "yaml");
});

test("常见语言加成后可以跨过阈值", () => {
  // 原始置信度略低，但加成后过线：VS Code 对常用语言有同样的加成。
  const detected = selectFilesDetectedLanguage([{ languageId: "json", confidence: 0.18 }], "{}");
  assert.equal(detected, "json");
});

test("识别 JSON 形状的内容", () => {
  assert.equal(filesLanguageDetectionLooksLikeJson('  {"a": 1}'), true);
  assert.equal(filesLanguageDetectionLooksLikeJson("\n[1, 2]"), true);
  assert.equal(filesLanguageDetectionLooksLikeJson("name: demo"), false);
});

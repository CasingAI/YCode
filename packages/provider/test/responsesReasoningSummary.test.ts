import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { applyOrderedJsonMergePatches, compileModelOptionMap } from "@zcode/model-option-map";
import { parseZCodeBuiltinModelConfigRules } from "../src/config/schema.js";

const BUILTIN_URL = new URL("../../../config/provider/zcode-builtin.json", import.meta.url);

interface ReasoningMapRule {
  readonly label: string;
  readonly apiTypeMatch: string | undefined;
  readonly map: string;
}

/** 读取内置配置里所有定义了 reasoningLevel.map 的规则，保留声明顺序供覆盖关系判断。 */
async function loadReasoningMapRules(): Promise<readonly ReasoningMapRule[]> {
  const release = JSON.parse(await readFile(BUILTIN_URL, "utf8")) as {
    config: { modelConfigRules: unknown };
  };
  return parseZCodeBuiltinModelConfigRules(release.config.modelConfigRules)
    .rules()
    .flatMap((rule, index) => {
      const map = rule.config.optionSpecs?.reasoningLevel?.map;
      if (map === undefined) return [];
      const meta = rule as unknown as { apiTypeMatch?: string; modelMatch?: string; type?: string };
      return [
        {
          label: `${meta.type ?? "?"}[${index}] ${meta.modelMatch ?? "?"}`,
          apiTypeMatch: meta.apiTypeMatch,
          map,
        },
      ];
    });
}

/** 走真实请求路径的两个函数：编译 map 得到 patch，再按 merge patch 语义落到请求体上。 */
function resolveBody(map: string, reasoningLevel: string): Record<string, unknown> {
  const patch = compileModelOptionMap(map, "reasoningLevel").evaluate(reasoningLevel);
  return applyOrderedJsonMergePatches({}, [{ option: "reasoningLevel", patch }]) as Record<
    string,
    unknown
  >;
}

function reasoningOf(body: Record<string, unknown>): Record<string, unknown> {
  const reasoning = body.reasoning;
  return reasoning !== null && typeof reasoning === "object" && !Array.isArray(reasoning)
    ? (reasoning as Record<string, unknown>)
    : {};
}

test("每条 openai-responses 的 reasoningLevel.map 都注入 reasoning.summary", async () => {
  const responsesRules = (await loadReasoningMapRules()).filter(
    (rule) => rule.apiTypeMatch === "openai-responses",
  );
  assert.ok(responsesRules.length > 0, "内置配置里应存在 openai-responses 的 reasoning 规则");
  assert.deepEqual(
    responsesRules.filter((rule) => !rule.map.includes('"summary"')).map((rule) => rule.label),
    [],
    "以下规则的 map 缺少 summary，该模型的思考内容不会显示",
  );
});

test("开启思考注入 summary=auto，关闭思考不注入且保留 effort", async () => {
  const responsesRules = (await loadReasoningMapRules()).filter(
    (rule) => rule.apiTypeMatch === "openai-responses",
  );
  for (const rule of responsesRules) {
    const enabled = reasoningOf(resolveBody(rule.map, "high"));
    assert.equal(enabled.summary, "auto", `${rule.label}: 开启思考应注入 summary=auto`);
    assert.ok("effort" in enabled, `${rule.label}: 注入 summary 不应挤掉 effort`);

    for (const off of ["disabled", "none"]) {
      const reasoning = reasoningOf(resolveBody(rule.map, off));
      assert.ok(
        !("summary" in reasoning),
        `${rule.label}: 关闭思考(${off})时 summary 应被 merge patch 删键`,
      );
      assert.ok("effort" in reasoning, `${rule.label}: 关闭思考(${off})时仍应保留 effort`);
    }
  }
});

test("不存在会覆盖掉 summary 的宽泛 reasoning 规则", async () => {
  // apiTypeMatch 未声明即对所有 apiType 生效，含 openai-responses；这类规则若写了 reasoning
  // 补丁却不含 summary，就会把更早规则注入的 summary 整体替换掉（map 不做字段级合并）。
  const broadRules = (await loadReasoningMapRules()).filter(
    (rule) => rule.apiTypeMatch === undefined || rule.apiTypeMatch === "openai-responses",
  );
  for (const rule of broadRules) {
    const patch = compileModelOptionMap(rule.map, "reasoningLevel").evaluate("high") as Record<
      string,
      unknown
    >;
    if (!("reasoning" in patch)) continue;
    assert.ok(
      rule.map.includes('"summary"'),
      `${rule.label}: 该规则会覆盖 reasoning 补丁但未注入 summary`,
    );
  }
});

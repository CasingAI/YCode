import assert from "node:assert/strict";
import test from "node:test";
import { mapSkillsToMentionItemsForTest } from "../src/mentions/providers/skillsMentionProvider.js";

// skill-title.md：mention 菜单的 label 用显示名，但 value/markdown 始终是机器标识 name。

test("mention 项 label 用显示名，插入值保持机器标识", () => {
  const items = mapSkillsToMentionItemsForTest(
    [
      {
        id: "glm:plugin:team:hash",
        name: "team",
        title: "Team dispatch handbook",
        description: "Team-mode dispatch handbook.",
        path: "C:/zcode-plugins-official/team/1.0.0/skills/team/SKILL.md",
        scope: "plugin",
        pluginName: "team",
      },
      {
        id: "glm:workspace:plain:hash",
        name: "plain",
        description: "plain skill",
        path: "C:/ws/.zcode/skills/plain/SKILL.md",
        scope: "workspace",
      },
    ],
    "zh-CN",
  );

  const teamItem = items.find((item) => item.value === "team");
  assert.ok(teamItem);
  // 内置技能优先本地化标题。
  assert.equal(teamItem.label, "Team 派工手册");
  assert.match(teamItem.markdown, /\$team/);

  const plainItem = items.find((item) => item.value === "plain");
  assert.ok(plainItem);
  assert.equal(plainItem.label, "plain");
});

test("显示名进入搜索关键词", () => {
  const items = mapSkillsToMentionItemsForTest(
    [
      {
        id: "glm:plugin:community:hash",
        name: "my-tool",
        title: "My Friendly Tool",
        description: "community skill",
        path: "C:/community-plugin/skills/my-tool/SKILL.md",
        scope: "plugin",
        pluginName: "community",
      },
    ],
    "en-US",
  );
  const item = items[0];
  assert.ok(item);
  assert.equal(item.label, "My Friendly Tool");
  assert.equal(item.keywords.includes("My Friendly Tool"), true);
});

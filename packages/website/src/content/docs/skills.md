> 本页改编自官方 zcode-guide 插件（Apache-2.0），并以本仓库检出为准修订。

技能（Skill）是「目录 + 一个 `SKILL.md`」形式的按需知识包：frontmatter 里的 `name` 与 `description` 告诉模型它是什么、什么时候用；正文是操作指引。技能不占常驻上下文——只有命中场景时才被加载。

## 创建一个技能

```text
my-skill/
  SKILL.md
```

`SKILL.md` 使用 YAML frontmatter：

```markdown
---
name: my-skill
description: 一句话说明这个技能做什么、什么时候触发。描述写得越具体，自动触发越可靠。
---

# 操作指引正文

给模型（或人）看的分步说明……
```

## 放在哪里

发现顺序（越靠前优先级越高）：

1. 显式配置的技能根目录
2. 用户级 `~/.zcode/skills/`
3. 用户级 `~/.agents/skills/`
4. 工作区 `.zcode/skills/`（从当前目录向上查到仓库根，**每一级都算**）
5. 工作区 `.agents/skills/`
6. 已启用插件的技能（优先级最低）

同一层内 `.zcode` 先于 `.agents` 扫描；更深的当前目录位置优先于仓库根位置。

## 同名遮蔽

技能的身份是**文件路径**：同名技能在不同路径都会被发现，但只有发现顺序里的第一个被加载——高优先级的副本遮蔽其余。想全局用某技能、只在某个仓库覆盖它：把覆盖版放进那个仓库的 `.zcode/skills/` 即可。

## 启用与禁用

- 用户配置（`~/.zcode/cli/config.json`）可以按技能禁用覆盖。
- 跨工具共享（Claude、Codex、Cursor 等）的技能放 `~/.agents/skills/`；只想在 YCode 内生效或覆盖的放 `.zcode/skills/`。
- 技能没有被触发、被同名遮蔽或被禁用时，排查思路见常见问题；技能也可以被模型经 Skill 工具显式调用。

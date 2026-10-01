> 本页改编自官方 zcode-guide 插件（Apache-2.0），并以本仓库检出为准修订。

自定义命令是 Markdown 文件形式的斜杠命令：把一段常用的提示词沉淀成 `/名字`，输入 `/` 即可唤起。

## 创建一个命令

```text
commands/
  review.md          → /review
  review/
    code.md          → /review:code（目录嵌套用冒号连接）
```

文件正文就是发送给模型的提示词；frontmatter 提供元数据：

```markdown
---
description: 对当前改动做一次代码评审
argument-hint: [关注点]
---

请评审当前工作区的改动，重点关注 $ARGUMENTS。
```

- `description`：命令列表里的说明文字。
- `argument-hint`：参数提示。
- 出现未知 frontmatter 键、或 frontmatter 格式非法时，该命令会被丢弃并产生可读的诊断信息（`custom_command_unknown_frontmatter` / `custom_command_invalid_frontmatter`），不会静默忽略。
- 正文中的 `$ARGUMENTS` 会在命令执行时展开为用户输入的参数。

## 放在哪里

发现顺序与[技能](/docs/skills)一致：显式配置根 → 用户 `~/.zcode/commands/` → 用户 `~/.agents/commands/` → 工作区 `.zcode/commands/`（逐级向上）→ 工作区 `.agents/commands/` → 已启用插件。

## 重名规则

命令按**规范化命令名**去重：发现顺序里第一个同名命令生效，其余被忽略——用户级覆盖工作区级，工作区级覆盖插件级。想确认某个 `/名字` 实际来自哪个文件，可以按发现顺序逐层排查。

## 禁用

用户配置里可以禁用单个自定义命令；被禁用的命令不再出现在 `/` 面板中。

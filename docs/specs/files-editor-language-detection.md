# Spec: 文件工作台编辑器语言识别

## 目标

文件工作台当前靠一张扩展名表猜语言（`filesMonacoLanguage.ts`）。这张表有三个可见问题：

1. **无扩展名的脚本识别不出来**。仓库里叫 `run`、`deploy` 的脚本没有任何扩展名，
   只能落回 `plaintext`；`.env`、`Dockerfile` 这类靠特例兜住了，但特例只覆盖了少数名字。
2. **通配形态的文件名识别不出来**。`tsconfig.app.json`、`docker-compose.prod.yml`
   这类按名字匹配语义的文件，只能按扩展名落到 `json` / `yaml`，部分场景语义并不对。
3. **用户手动改过的语言会丢**。状态栏语言菜单只改 Monaco 的语言模式，不落任何地方；
   标签页关闭后模型被释放，再次打开时又按扩展名推断回去。

本 spec 把语言识别改成一条**有优先级、可解释**的解析链，并让用户的选择能留下来。

解析链参考 VS Code 的关联机制（`languagesAssociations.ts` / `languagesRegistry.ts`），
但收敛为四层：

```text
用户关联 → 内置文件名/通配模式/扩展名 → 首行规则 → 兜底
```

上游 spec：`workspace-files.md`（文件主视图与工作台结构）、
`files-editor-status-bar.md`（编辑器状态栏，语言条目在其中的交互）。

## 已对齐决策

| 边界     | 决定                                                                          |
| -------- | ----------------------------------------------------------------------------- |
| 推断入口 | 单一纯函数 `resolveFilesEditorLanguage`，返回语言 id **和命中来源**           |
| 优先级   | 用户关联 > 内置精确文件名 > 内置通配模式 > 扩展名 > 首行规则 > 兜底           |
| 用户关联 | 存 `AppSettings.fileLanguageAssociations`，本机 `settings.json`，不随账号同步 |
| 手动选择 | 一旦用户显式改过语言，推断结果不得覆盖该文件的选择                            |
| 内容识别 | 内置规则完全落空时才用 guesslang 模型兜底（Web Worker，不覆盖已有结论）       |
| 平台     | Desktop / Web / 远程工作区同一套纯函数，无平台差异                            |

## 产品规则

### 解析链

`resolveFilesEditorLanguage({ path, firstLine, associations })` 返回
`{ languageId, source }`，`source` 取值：

| 序  | source             | 规则                 | 例子                                             |
| --- | ------------------ | -------------------- | ------------------------------------------------ |
| 1   | `user-file`        | 用户关联命中绝对路径 | `/repo/app.foo` → `typescript`                   |
| 2   | `user-pattern`     | 用户关联命中通配模式 | `*.foo` → `typescript`                           |
| 3   | `filename`         | 内置精确文件名表     | `Dockerfile` → `dockerfile`、`.bashrc` → `shell` |
| 4   | `filename-pattern` | 内置通配模式表       | `tsconfig.*.json` → `json`                       |
| 5   | `extension`        | 内置扩展名表         | `.ts` → `typescript`、`.rs` → `rust`             |
| 6   | `first-line`       | 首行正则表           | `#!/bin/bash` → `shell`                          |
| 7   | `default`          | 兜底                 | `plaintext`                                      |

- **用户关联永远最高**，且任何其它层都不得覆盖它。
- **首行规则排在扩展名之后**。文件名的证据强于 shebang：`a.txt` 即使首行是
  `#!/bin/bash` 仍是 `plaintext`；只有无扩展名、扩展名未知的文件才会走到首行规则。
- **路径比较统一转小写**（与既有实现一致），扩展名与文件名比对不区分大小写；
  路径分隔符同时兼容 `\` 与 `/`。
- **通配模式匹配取最长命中**；长度相同时按字典序取前者，保证结果稳定可复现。

### 用户关联

- 关联表是 `Record<string, string>`：键是模式或绝对路径，值是 Monaco 语言 id。
- 键的两种形态：
  - **绝对路径**：只影响这一个文件（`/repo/src/app.foo`）。
  - **通配模式**：影响所有匹配的文件（`*.foo`、`tsconfig.*.json`）。
- 匹配顺序：绝对路径精确命中 > 最长通配模式命中。
- 关联表里出现 Monaco 未注册的语言 id 时，该条关联被忽略（不落到 `plaintext`，
  也不报错）。

### 首行规则

首行规则表来自两处：VS Code 内置扩展的 `contributes.languages.firstLine` 声明
（typescript 的 `^#!.*\b(deno|bun|ts-node)\b`、yaml 的 `^#cloud-config`），
以及常见解释器 shebang。首行超长时只取前若干字符参与匹配。

### 手动选择

- 状态栏语言菜单切换语言：只改当前 Monaco model 的语言模式，**不改文件内容**。
- 一旦用户对某个文件显式改过语言，该选择记录在该 model 上；此后模型被复用
  （切换标签页、内容重灌、重新解析）时，**推断结果不得覆盖它**。
- 用户可以把选择保存成关联：
  - 「按模式」：写入 `*.ext` → 语言，对所有同后缀文件生效。
  - 「按文件」：写入绝对路径 → 语言，只对该文件生效。
- 保存后立即生效：当前 model 的语言不变（本来就是用户选的那个），
  之后打开的文件按关联命中。

### 内容级兜底

内置规则完全落空（解析来源是 `default`）时，才看内容：

- 模型用 [`@vscode/vscode-languagedetection`](https://github.com/microsoft/vscode-languagedetection)（MIT），
  底层是 guesslang 的 ML 模型，覆盖 54 种语言。
- 推理跑在 **Web Worker** 里（`filesLanguageDetection.worker.ts`），不阻塞主线程；
  后端抽象见 `filesLanguageDetectionBackend.ts`，与
  `workspaceFileSearchFilterBackend.ts` 同款：seq 去旧、Promise 不 reject、失败降级。
- **只有内置规则落空才触发**，且检测结果**不得覆盖**用户显式选定的语言。
- 置信度处理见 `filesLanguageDetectionConfidence.ts`：
  - 常用语言加成（json/ts/js/py/css/html/xml/php +0.05，cpp/sh/java/cs/c +0.025）；
  - 已知易误判语言惩罚（bat/ini/makefile/sql/csv/toml −0.5）；
  - **yaml 不加成也不惩罚**（VS Code 的原注释：YAML 语法太简单，容易造成错误检测）；
  - 阈值 0.2（VS Code 的 `expectedRelativeConfidence`）；
  - **JSON 防护**：内容以 `{` / `[` 开头且模型把 YAML 排在前面时改选 JSON
    （模型仓库有「JSON 被判成 YAML」的已知报告，microsoft/vscode-languagedetection#3）；
  - 与 VS Code 的一处刻意差异：只用**修正后**的置信度判断阈值，VS Code 会先用原始值
    判断一次，原始值略低就直接放弃（加成白加）。
- **平台差异**：该包的产物是 webpack `target: 'node'` 的 UMD，浏览器里要接两处：
  1. 权重与模型结构不能走 node 的 `fs`：构建时把它们内联成 data URL，Worker 里 fetch；
  2. tfjs 被 webpack 拆成运行时才加载的 chunk，node 的同步 `require` 浏览器里没有：
     改为静态预导入该 chunk，并把全局 `require` 指向它。
     桌面端 renderer 走 `file://` 协议，fetch 读不到 `file://` 资源，
     因此 Web / Desktop 两端的构建配置都用 `build.assetsInlineLimit` 判定函数
     只把模型文件内联成 data URL。
- 模型加载或推理失败时一律返回「没有结论」，文件保持 `plaintext`，不报错、不卡顿。

### 设置页

- 设置页新增「文件与编辑器」分区，列出全部关联（模式/路径 → 语言），
  支持新增、修改、删除。
- 新增关联时的语言下拉按**流行度降序**列出可选语言（与状态栏语言浮层同一份
  排名表，见 `filesEditorLanguagePopularity.ts`），不按首字母序。
  排名的口径与数据来源见 `files-editor-status-bar.md` 的「流行度数据来源」。
- 关联表是本机设置，不随账号同步；界面需说明这一点。

## 状态所有者

| 状态                                      | 所有者                                              | 说明                                                           |
| ----------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------- |
| 内置语言规则表（文件名/模式/扩展名/首行） | `filesEditorLanguageRules.ts`                       | 纯数据 + 纯函数，无 IO                                         |
| 通配匹配                                  | `filesEditorLanguageGlob.ts`                        | 纯函数，`*` 不跨分隔符、`**` 跨分隔符、`?` 匹配单字符          |
| 用户关联表                                | `AppSettings.fileLanguageAssociations`              | 经 `ISettingService` 写本机 `settings.json`；zod 校验在 shared |
| 某文件的显式语言选择                      | Monaco model 侧的显式标记（`filesMonacoModels.ts`） | 只在内存里活到 model 释放；跨会话的持久化由用户关联表承担      |
| 内容级检测结果                            | `filesLanguageDetectionBackend.ts`                  | Worker 后端；不缓存第二份真相，失败即「没有结论」              |
| 解析结果                                  | 无独立存储                                          | 每次打开文件现算，不缓存第二份真相                             |

## 事件顺序

```text
打开文件
  → FilesMonacoEditor 拿到 buffer.path / buffer.text
  → resolveFilesEditorLanguage({ path, firstLine, associations })
  → getOrCreateFilesMonacoModel(..., languageId)
  → 模型复用时：若该 model 已有显式语言则保留，否则套用本次解析结果

用户点状态栏语言 → 选 typescript
  → handle.setLanguage("typescript")
  → monaco.editor.setModelLanguage(model, "typescript")
  → 记录为该 model 的显式语言

用户点「保存为关联…」→ 选「按模式」
  → settings.update({ fileLanguageAssociations: { ...prev, "*.foo": "typescript" } })
  → 之后打开 *.foo 在第 2 条命中
```

- 解析是**同步纯函数**，不引入新的异步时序。
- 显式语言标记只影响「模型复用时是否覆盖」，不参与解析链本身。

## 负面边界

- 不接 LSP，不读 tsconfig / paths，不做项目级语言服务。
- 不做 MIME 协商，不调用系统 `file(1)`。
- 内容级检测只做「兜底」，不做主路径：内置规则有结论时一律不跑模型。
- 不引入 `vscode-regexp-languagedetection`（未公开发布，npm 与 GitHub 都取不到）。
- 不改工作台缓冲的脏态判定、冲突判定与保存链路。
- 不把 Monaco 原始对象透传给 UI 层。
- 不新增协议字段，不改 `zcode-protocol`。

## 验收场景

1. 打开 `src/app.ts` → 语言 `typescript`；打开 `Cargo.toml` → `ini`；
   打开 `tsconfig.app.json` → `json`。
2. 打开无扩展名的 `run`（首行 `#!/bin/bash`）→ 语言 `shell`。
3. 打开 `Dockerfile` → `dockerfile`；打开 `Makefile` → `makefile`；
   打开 `.gitignore` → `plaintext`。
4. 打开 `.env` → `ini`；打开 `README` → `markdown`。
5. 手动把 `plaintext` 改成 `typescript`：当次生效；关掉标签页再打开仍是
   `typescript`（显式语言不被推断覆盖）。
6. 语言菜单点「保存为关联…」→ 选「按模式」→ 写入 `*.foo` → 之后所有 `.foo`
   文件自动是 `typescript`。
7. 同上选「按文件」→ 写入绝对路径 → 只有该文件受影响，其它同后缀文件不受影响。
8. 设置页「文件与编辑器」分区可查看、修改、删除关联；删除后该文件回到推断结果。
9. 用户关联指向 Monaco 未注册的语言 id → 该关联被忽略，文件按内置规则解析。
10. `pnpm typecheck`、`pnpm lint`、`pnpm fmt:check`、
    `pnpm architecture:check --changed` 通过；规则层与匹配器有单测。

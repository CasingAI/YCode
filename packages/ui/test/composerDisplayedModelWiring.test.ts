import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

// 接线断言（docs/specs/composer-displayed-model.md）：纯函数与组合链路已由
// composerDisplayedModel.test.ts / aiSearchModelInput.test.ts 覆盖，这里确认真实
// React 组件把前台门、唯一写入口和浮层重开读取接了回去。node 测试环境没有 DOM，
// 不能挂载 React effect；因此读源码 AST，而不是把 UI 行为称作已执行的 E2E。

async function readSource(relativePath: string): Promise<string> {
  return readFile(new URL(relativePath, import.meta.url), "utf8");
}

async function readAndParse(relativePath: string): Promise<{ text: string; file: ts.SourceFile }> {
  const text = await readSource(relativePath);
  return {
    text,
    file: ts.createSourceFile(relativePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX),
  };
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

function findCalls(root: ts.Node, name: string): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  walk(root, (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === name
    ) {
      calls.push(node);
    }
  });
  return calls;
}

function findCallContaining(
  root: ts.Node,
  name: string,
  needle: string,
  sourceFile: ts.SourceFile,
): ts.CallExpression | undefined {
  return findCalls(root, name).find((call) => call.getText(sourceFile).includes(needle));
}

function objectPropertyNames(
  node: ts.ObjectLiteralExpression,
  sourceFile: ts.SourceFile,
): Set<string> {
  const names = new Set<string>();
  for (const property of node.properties) {
    if (
      ts.isPropertyAssignment(property) ||
      ts.isShorthandPropertyAssignment(property) ||
      ts.isMethodDeclaration(property)
    ) {
      names.add(property.name.getText(sourceFile));
    }
  }
  return names;
}

function findProperty(
  node: ts.ObjectLiteralExpression,
  name: string,
  sourceFile: ts.SourceFile,
): ts.PropertyAssignment | ts.ShorthandPropertyAssignment | undefined {
  return node.properties.find(
    (property): property is ts.PropertyAssignment | ts.ShorthandPropertyAssignment =>
      (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
      property.name.getText(sourceFile) === name,
  );
}

function dependencyNames(node: ts.CallExpression, sourceFile: ts.SourceFile): string[] {
  const deps = node.arguments[1];
  assert.ok(deps && ts.isArrayLiteralExpression(deps), "useEffect/useMemo 缺少依赖数组");
  return deps.elements.map((element) => element.getText(sourceFile));
}

test("SessionPane effect 使用统一前台判据，且 telemetryVisible 接到 visible", async () => {
  const { file } = await readAndParse("../src/v4/SessionPane.tsx");
  const effect = findCallContaining(
    file,
    "useEffect",
    "resolveForegroundDisplayedModelSelection",
    file,
  );
  assert.ok(effect, "SessionPane 没有调用 resolveForegroundDisplayedModelSelection 的 effect");

  const resolveCall = findCalls(effect, "resolveForegroundDisplayedModelSelection")[0];
  assert.ok(resolveCall);
  const args = resolveCall.arguments[0];
  assert.ok(args && ts.isObjectLiteralExpression(args));
  const foregroundProperty = findProperty(args, "foreground", file);
  assert.ok(foregroundProperty && ts.isPropertyAssignment(foregroundProperty));
  const foreground = foregroundProperty.initializer;
  assert.ok(ts.isObjectLiteralExpression(foreground));

  assert.deepEqual(
    [...objectPropertyNames(foreground, file)].sort(),
    ["focused", "readOnly", "selectionSideChat", "visible"],
    "前台判据必须只由 focused/visible/readOnly/selectionSideChat 四项组成",
  );
  const visible = findProperty(foreground, "visible", file);
  assert.ok(visible && ts.isPropertyAssignment(visible));
  assert.equal(
    visible.initializer.getText(file),
    "telemetryVisible",
    "visible 必须接 pane 的 telemetryVisible，而不是别的可见性信号",
  );

  const deps = dependencyNames(effect, file);
  for (const dependency of [
    "focused",
    "telemetryVisible",
    "readOnly",
    "selectionSideChat",
    "modelSelectionView",
    "workspacePath",
    "workspaceIdentity",
  ]) {
    assert.ok(
      deps.includes(dependency),
      `effect 依赖缺少 ${dependency}，焦点/目录/scope 变化不会重新求值`,
    );
  }
  assert.match(effect.getText(file), /if \(!selection\) return;/);
});

test("SessionPane effect 是唯一写入口：从前台判据结果写入同一 workspace/selection/identity", async () => {
  const { file } = await readAndParse("../src/v4/SessionPane.tsx");
  const effect = findCallContaining(
    file,
    "useEffect",
    "resolveForegroundDisplayedModelSelection",
    file,
  );
  assert.ok(effect);

  const recordCall = findCalls(effect, "recordComposerDisplayedModel")[0];
  assert.ok(recordCall, "effect 没有调用 recordComposerDisplayedModel");
  assert.deepEqual(
    recordCall.arguments.map((argument) => argument.getText(file)),
    ["workspacePath", "selection", "workspaceIdentity"],
    "写入口参数必须与读取侧使用同一组 workspacePath/selection/workspaceIdentity",
  );
});

test("SessionPane 记录的展示来源与工具栏展示配置同源于 draftConfig.modelSelection", async () => {
  const sessionPane = (await readAndParse("../src/v4/SessionPane.tsx")).text;
  // effect 读取 draftConfig 的具体选择三要素；缺失任一项都不构造选择。
  assert.match(sessionPane, /draftConfig\.modelSelection\?\.providerId/);
  assert.match(sessionPane, /draftConfig\.modelSelection\?\.modelId/);
  assert.match(sessionPane, /draftConfig\.modelSelection\?\.options\?\.reasoningLevel/);

  // 工具栏只把 draftConfig 投影成展示配置，展示配置的唯一选择来源也是 modelSelection。
  const toolbar = (await readAndParse("../src/v4/composer/V4ComposerToolbar.tsx")).text;
  assert.match(toolbar, /resolveDraftDisplayedConfig\(draftConfig \?\? \{\}\)/);
  const displayedConfig = (await readAndParse("../src/v4/composer/draftWorkspaceDefaults.ts")).text;
  assert.match(displayedConfig, /const selection = composer\.modelSelection;/);
  assert.match(displayedConfig, /modelSelection: selection/);
});

test("命令中心 AI 搜索输入：displayed 优先于 recent，open 参与依赖以支持重开重读", async () => {
  const { file } = await readAndParse("../src/command-center/CommandCenterDialog.tsx");
  const memo = findCallContaining(file, "useMemo", "resolveAiSearchModelInput", file);
  assert.ok(memo, "CommandCenterDialog 缺少构造 aiSearchModelInput 的 useMemo");

  assert.match(
    memo.getText(file),
    /resolveAiSearchModelInput\(\s*readComposerDisplayedModel\(\s*workspaceAbsPath,\s*workspaceIdentity\s*\),\s*readComposerRecent\(\s*workspaceAbsPath,\s*workspaceIdentity\s*\)\?\.modelSelection,?\s*\)/s,
    "输入顺序必须是 displayed → recent，两者都按 workspaceIdentity 读取",
  );

  const deps = dependencyNames(memo, file);
  for (const dependency of [
    "open",
    "modelSelectionReady",
    "workspaceAbsPath",
    "workspaceIdentity",
  ]) {
    assert.ok(
      deps.includes(dependency),
      `aiSearchModelInput 依赖缺少 ${dependency}，重开浮层不会重新读取本地记录`,
    );
  }
});

test("命令中心副文案与 startAiHistorySearch 使用同一份 aiSearchModelInput", async () => {
  const { file, text } = await readAndParse("../src/command-center/CommandCenterDialog.tsx");

  // runner 的模型读写在发起时才 getView；副文案的视图必须吃同一份 input。
  assert.match(text, /modelSelectionInput:\s*aiSearchModelInput/);
  const viewCall = findCalls(file, "useModelSelectionServiceView")[0];
  assert.ok(viewCall, "CommandCenterDialog 没有调用 useModelSelectionServiceView");
  assert.equal(
    viewCall.arguments[3]?.getText(file),
    "aiSearchModelInput",
    "副文案的模型视图必须与发起搜索使用同一份 aiSearchModelInput",
  );
});

test("命令中心只读 displayed 记录，不回写", async () => {
  const { text } = await readAndParse("../src/command-center/CommandCenterDialog.tsx");
  assert.match(text, /readComposerDisplayedModel\(/, "命令中心必须读取 displayed 记录");
  assert.equal(
    text.includes("recordComposerDisplayedModel("),
    false,
    "读取方不得调用写入口；写入只允许留在 SessionPane 前台 effect",
  );
});

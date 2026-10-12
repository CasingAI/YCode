// 把沙盒源码里的 ESM import / import() 改写成 require。
// 原因与修复依据：eval 包进 async IIFE 后静态 import 非法，动态 import 走 QuickJS
// 模块加载器会交出 “could not load module”，与受限 require 的 SANDBOX_NO_MODULE 不一致。
// 模型常写 import + 顶层 return；module 目标下顶层 return 非法，解析前把 return 换成
// 等长的 void 前缀，AST 区间仍对准原文。

import { parseModule, parseScript, type ESTree } from "meriyah";

const IMPORT_WORD = /\bimport\b/;
const SCRIPT_PROBE_PREFIX = "async function __sandbox_import_probe() { ";
const SCRIPT_PROBE_SUFFIX = "\n}";

interface SourceSpan {
  start: number;
  end: number;
}

interface Replacement {
  start: number;
  end: number;
  text: string;
}

export function rewriteSandboxImports(code: string): string {
  if (!IMPORT_WORD.test(code)) return code;
  const parsed = parseImportAst(code);
  if (!parsed) return code;
  const replacements: Replacement[] = [];
  walk(parsed.ast, (node) => {
    if (node.type === "ImportDeclaration") {
      const span = shiftSpan(nodeSpan(node), parsed.rangeOffset);
      const text = rewriteImportDeclaration(node, code, parsed.rangeOffset);
      if (span && text !== undefined) replacements.push({ ...span, text });
      return;
    }
    if (node.type === "ImportExpression") {
      const span = shiftSpan(nodeSpan(node), parsed.rangeOffset);
      const text = rewriteImportExpression(node, code, parsed.rangeOffset);
      if (span && text !== undefined) replacements.push({ ...span, text });
    }
  });
  if (replacements.length === 0) return code;
  return applyReplacements(code, replacements);
}

function parseImportAst(code: string): { ast: ESTree.Program; rangeOffset: number } | undefined {
  try {
    return {
      ast: parseModule(maskReturnsForModuleParse(code), { next: true, ranges: true }),
      rangeOffset: 0,
    };
  } catch {
    try {
      return {
        ast: parseScript(`${SCRIPT_PROBE_PREFIX}${code}${SCRIPT_PROBE_SUFFIX}`, {
          next: true,
          ranges: true,
        }),
        rangeOffset: SCRIPT_PROBE_PREFIX.length,
      };
    } catch {
      return undefined;
    }
  }
}

/**
 * 等长替换：`return;` → `void 0;`，其余 `return` → `void  `，让带顶层 return 的
 * 源码能按 module 解析，且 import 节点区间仍对应原文。
 */
function maskReturnsForModuleParse(code: string): string {
  return code.replace(/\breturn;/g, "void 0;").replace(/\breturn\b/g, "void  ");
}

function rewriteImportDeclaration(
  node: ESTree.ImportDeclaration,
  code: string,
  rangeOffset: number,
): string | undefined {
  const sourceSpan = shiftSpan(nodeSpan(node.source), rangeOffset);
  if (!sourceSpan) return undefined;
  const requireCall = `require(${code.slice(sourceSpan.start, sourceSpan.end)})`;
  if (node.specifiers.length === 0) return `${requireCall};`;
  const statements: string[] = [];
  const named: string[] = [];
  for (const specifier of node.specifiers) {
    if (specifier.type === "ImportDefaultSpecifier" || specifier.type === "ImportNamespaceSpecifier") {
      statements.push(`const ${specifier.local.name} = ${requireCall}`);
      continue;
    }
    if (specifier.type === "ImportSpecifier") {
      const binding = namedImportBinding(specifier);
      if (binding === undefined) return undefined;
      named.push(binding);
      continue;
    }
    return undefined;
  }
  if (named.length > 0) {
    statements.push(`const { ${named.join(", ")} } = ${requireCall}`);
  }
  return `${statements.join("; ")};`;
}

function rewriteImportExpression(
  node: ESTree.ImportExpression,
  code: string,
  rangeOffset: number,
): string | undefined {
  const sourceSpan = shiftSpan(nodeSpan(node.source), rangeOffset);
  if (!sourceSpan) return undefined;
  return `Promise.resolve().then(() => require(${code.slice(sourceSpan.start, sourceSpan.end)}))`;
}

function namedImportBinding(specifier: ESTree.ImportSpecifier): string | undefined {
  const imported = specifier.imported;
  if (imported.type === "Identifier") {
    return imported.name === specifier.local.name
      ? imported.name
      : `${imported.name}: ${specifier.local.name}`;
  }
  if (imported.type === "Literal" && typeof imported.value === "string") {
    return `${JSON.stringify(imported.value)}: ${specifier.local.name}`;
  }
  return undefined;
}

function applyReplacements(code: string, replacements: Replacement[]): string {
  const ordered = replacements.toSorted((left, right) => right.start - left.start);
  let next = code;
  let lastStart = Number.POSITIVE_INFINITY;
  for (const replacement of ordered) {
    if (replacement.start < 0 || replacement.end > code.length || replacement.start >= replacement.end) {
      continue;
    }
    if (replacement.end > lastStart) continue;
    next = `${next.slice(0, replacement.start)}${replacement.text}${next.slice(replacement.end)}`;
    lastStart = replacement.start;
  }
  return next;
}

function nodeSpan(node: ESTree._Node): SourceSpan | undefined {
  if (typeof node.start === "number" && typeof node.end === "number") {
    return { start: node.start, end: node.end };
  }
  if (node.range) return { start: node.range[0], end: node.range[1] };
  return undefined;
}

function shiftSpan(span: SourceSpan | undefined, rangeOffset: number): SourceSpan | undefined {
  if (!span) return undefined;
  return { start: span.start - rangeOffset, end: span.end - rangeOffset };
}

function walk(node: unknown, visit: (node: ESTree.Node) => void): void {
  if (!node || typeof node !== "object") return;
  const current = node as ESTree.Node;
  if (typeof current.type === "string") visit(current);
  for (const value of Object.values(current)) {
    if (Array.isArray(value)) {
      for (const item of value) walk(item, visit);
      continue;
    }
    walk(value, visit);
  }
}

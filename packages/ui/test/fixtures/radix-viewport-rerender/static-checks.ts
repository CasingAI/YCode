import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

import type { Check, Metrics } from "./scenario-types.js";

const RADIX_PACKAGES = [
  {
    dir: "@radix-ui/react-select",
    sourceFile: "select.tsx",
    version: "2.2.6",
    viewport: "SelectViewport",
    postViewport: "SelectItem",
    selector: "data-radix-select-viewport",
  },
  {
    dir: "@radix-ui/react-scroll-area",
    sourceFile: "scroll-area.tsx",
    version: "1.2.10",
    viewport: "ScrollAreaViewport",
    postViewport: "ScrollAreaThumb",
    selector: "data-radix-scroll-area-viewport",
  },
] as const;

const VLQ_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const VLQ_VALUES = new Map([...VLQ_CHARS].map((char, index) => [char, index]));

type Segment = {
  generatedColumn: number;
  sourceIndex?: number;
  sourceLine?: number;
  sourceColumn?: number;
};

type MappedLine = {
  detail: unknown;
  ok: boolean;
  source?: string;
  sourceLineText?: string;
};

function decodeSegment(text: string): number[] {
  const values: number[] = [];
  let value = 0;
  let shift = 0;
  for (const char of text) {
    const digit = VLQ_VALUES.get(char);
    if (digit === undefined) throw new Error(`非法 source map VLQ 字符: ${char}`);
    value += (digit & 31) << shift;
    if (digit & 32) {
      shift += 5;
      continue;
    }
    const negative = value & 1;
    const magnitude = value >>> 1;
    values.push(negative ? -magnitude : magnitude);
    value = 0;
    shift = 0;
  }
  return values;
}

function decodeMappings(mappings: string): Segment[][] {
  const lines: Segment[][] = [];
  let sourceIndex = 0;
  let sourceLine = 0;
  let sourceColumn = 0;
  for (const lineText of mappings.split(";")) {
    let generatedColumn = 0;
    const segments: Segment[] = [];
    for (const segmentText of lineText.split(",")) {
      if (!segmentText) continue;
      const values = decodeSegment(segmentText);
      generatedColumn += values[0] ?? 0;
      if (values.length === 1) {
        segments.push({ generatedColumn });
        continue;
      }
      sourceIndex += values[1] ?? 0;
      sourceLine += values[2] ?? 0;
      sourceColumn += values[3] ?? 0;
      segments.push({ generatedColumn, sourceIndex, sourceLine, sourceColumn });
    }
    lines.push(segments);
  }
  return lines;
}

function readMappedLine(
  distLines: string[],
  map: { mappings: string; sources: string[]; sourcesContent?: (string | null)[] },
  decoded: Segment[][],
  marker: string,
): MappedLine {
  const generatedLine = distLines.findIndex((line) => line.includes(marker));
  if (generatedLine < 0) return { detail: { marker }, ok: false };
  const segment = (decoded[generatedLine] ?? []).find((item) => item.sourceIndex !== undefined);
  if (!segment || segment.sourceLine === undefined) {
    return { detail: { generatedLine: generatedLine + 1, marker }, ok: false };
  }
  const source = map.sources[segment.sourceIndex ?? -1] ?? "";
  const content = map.sourcesContent?.[segment.sourceIndex ?? -1] ?? "";
  const sourceLineText = content.split(/\r?\n/)[segment.sourceLine] ?? "";
  return {
    detail: { generatedLine: generatedLine + 1, source, sourceLine: segment.sourceLine + 1 },
    ok: true,
    source,
    sourceLineText,
  };
}

function findStyleConstant(content: string, selector: string) {
  const matches = [
    ...content.matchAll(/([A-Za-z_$][\w$]*)\s*=\s*\{\s*__html:\s*`([^`]*)`\s*\}/g),
  ].filter((match) => match[2]?.includes(selector));
  return matches.map((match) => ({ css: match[2] ?? "", name: match[1] ?? "" }));
}

export async function runStaticChecks(
  check: Check,
  metrics: Metrics,
  repoRoot: string,
): Promise<void> {
  const require = createRequire(import.meta.url);
  for (const pkg of RADIX_PACKAGES) {
    const packageDir = resolve(repoRoot, "node_modules", pkg.dir);
    const manifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8")) as {
      version: string;
    };
    metrics[`static:${pkg.dir}`] = { version: manifest.version };
    check(
      `静态: ${pkg.dir} 版本为 ${pkg.version}`,
      manifest.version === pkg.version,
      manifest.version,
    );

    for (const file of ["dist/index.mjs", "dist/index.js"]) {
      const distPath = join(packageDir, file);
      const content = await readFile(distPath, "utf8");
      const constants = findStyleConstant(content, pkg.selector);
      check(
        `静态: ${pkg.dir} ${file} 固定样式使用模块级常量`,
        constants.length === 1 && constants[0]?.name.length > 0,
        { count: constants.length },
      );
      const styleConstant = constants[0];
      if (!styleConstant) continue;
      check(
        `静态: ${pkg.dir} ${file} 固定样式常量内容与 Radix 选择器一致`,
        styleConstant.css.includes(pkg.selector) &&
          styleConstant.css.includes("::-webkit-scrollbar"),
        { selector: pkg.selector },
      );
      check(
        `静态: ${pkg.dir} ${file} 不再内联固定样式对象`,
        !content.includes("dangerouslySetInnerHTML: {") &&
          content.includes(`dangerouslySetInnerHTML: ${styleConstant.name}`),
        { constant: styleConstant.name },
      );

      const mapMatch = /sourceMappingURL=([^\s*]+)/.exec(content);
      if (!mapMatch) {
        check(`静态: ${pkg.dir} ${file} 存在 source map`, false, {});
        continue;
      }
      const map = JSON.parse(
        await readFile(join(dirname(distPath), mapMatch[1] ?? ""), "utf8"),
      ) as {
        mappings: string;
        sources: string[];
        sourcesContent?: (string | null)[];
      };
      const decoded = decodeMappings(map.mappings);
      const distLines = content.split(/\r?\n/);

      const viewport = readMappedLine(distLines, map, decoded, `var ${pkg.viewport} = `);
      check(
        `静态: ${pkg.dir} ${file} source map 仍指向 Viewport 源码`,
        viewport.ok &&
          viewport.source.endsWith(pkg.sourceFile) &&
          (viewport.sourceLineText ?? "").includes(pkg.viewport),
        viewport.detail,
      );

      const style = readMappedLine(distLines, map, decoded, "dangerouslySetInnerHTML: ");
      check(
        `静态: ${pkg.dir} ${file} source map 仍指向固定样式源码`,
        style.ok && style.source.endsWith(pkg.sourceFile),
        style.detail,
      );

      const postViewport = readMappedLine(distLines, map, decoded, `var ${pkg.postViewport} = `);
      check(
        `静态: ${pkg.dir} ${file} source map 后续组件坐标未偏移`,
        postViewport.ok && (postViewport.sourceLineText ?? "").includes(pkg.postViewport),
        postViewport.detail,
      );
      metrics[`static:${pkg.dir}:${file}`] = {
        constant: styleConstant.name,
        mapSource: viewport.detail,
      };
    }

    try {
      const cjs = require(pkg.dir) as Record<string, unknown>;
      check(`静态: ${pkg.dir} CJS require 导出 Root/Viewport`, Boolean(cjs.Root && cjs.Viewport), {
        exports: Object.keys(cjs).filter((key) => key === "Root" || key === "Viewport"),
      });
    } catch (error) {
      check(`静态: ${pkg.dir} CJS require 导出 Root/Viewport`, false, String(error));
    }

    try {
      const esm = (await import(pkg.dir)) as Record<string, unknown>;
      check(`静态: ${pkg.dir} ESM import 导出 Root/Viewport`, Boolean(esm.Root && esm.Viewport), {
        exports: Object.keys(esm).filter((key) => key === "Root" || key === "Viewport"),
      });
    } catch (error) {
      check(`静态: ${pkg.dir} ESM import 导出 Root/Viewport`, false, String(error));
    }
  }
}

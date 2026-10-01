// 内容加载层：slug → markdown 源文。
// 构建期经 Vite 的 glob + ?raw 内联为字符串，运行时无 IO。

const modules = import.meta.glob("./docs/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

export function loadDocSource(slug: string): string | undefined {
  return modules[`./docs/${slug}.md`];
}

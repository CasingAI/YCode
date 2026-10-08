import { CHANGELOG_VERSIONS } from "../changelog.js";
import { Markdown } from "../markdown.js";

// 各版本正文：构建期经 ?raw 内联仓库根 changelogs/ 下的独立 MD，页面只做展示。
// 发版流程：changelogs/ 新增 vX.Y.Z.md → changelog.ts 注册一行 → 重新构建。
const versionSources = import.meta.glob("../../../../changelogs/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function loadVersionSource(slug: string): string | undefined {
  return versionSources[`../../../../changelogs/${slug}.md`];
}

export function ChangelogPage() {
  if (CHANGELOG_VERSIONS.length === 0) {
    return (
      <article>
        <h1 className="text-2xl font-bold">更新日志</h1>
        <p className="mt-3">暂无版本记录。</p>
      </article>
    );
  }

  const scrollTo = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="mx-auto flex w-full max-w-6xl gap-10 px-4 py-8 sm:px-6">
      <aside className="sticky top-16 hidden h-[calc(100vh-4rem)] w-56 shrink-0 overflow-y-auto md:block">
        <nav aria-label="版本导航">
          <div className="mb-1.5 text-xs font-semibold tracking-wide text-[color:var(--site-faint)] uppercase">
            版本
          </div>
          <ul>
            {CHANGELOG_VERSIONS.map((version) => (
              <li key={version.slug}>
                <button
                  type="button"
                  onClick={() => scrollTo(version.slug)}
                  className="block w-full rounded-md px-2 py-1 text-left text-sm text-[color:var(--site-fg-subtle)] hover:bg-[color:var(--site-bg-soft)] hover:text-[color:var(--site-fg)]"
                >
                  {version.title} —— {version.date}
                </button>
              </li>
            ))}
          </ul>
        </nav>
      </aside>
      <main className="min-w-0 flex-1">
        <details className="mb-6 md:hidden">
          <summary className="cursor-pointer rounded-md border border-[color:var(--site-border)] px-3 py-2 text-sm">
            版本导航
          </summary>
          <ul className="mt-3">
            {CHANGELOG_VERSIONS.map((version) => (
              <li key={version.slug}>
                <button
                  type="button"
                  onClick={() => scrollTo(version.slug)}
                  className="block w-full rounded-md px-2 py-1 text-left text-sm text-[color:var(--site-fg-subtle)]"
                >
                  {version.title} —— {version.date}
                </button>
              </li>
            ))}
          </ul>
        </details>
        <article className="max-w-3xl">
          <h1>更新日志</h1>
          {CHANGELOG_VERSIONS.map((version) => {
            const source = loadVersionSource(version.slug);
            if (!source) return null;
            return (
              <section key={version.slug} id={version.slug} className="scroll-mt-20">
                <Markdown source={source.trim()} />
              </section>
            );
          })}
        </article>
      </main>
    </div>
  );
}

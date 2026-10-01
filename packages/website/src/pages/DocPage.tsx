import { useEffect } from "react";
import { Link } from "../router.js";
import { docNeighbors, findDocPage, DOC_GROUPS } from "../site.js";
import { loadDocSource } from "../content/docs.js";
import { Markdown } from "../markdown.js";

function DocNotFound({ slug }: { slug: string }) {
  return (
    <article>
      <h1 className="text-2xl font-bold">页面不存在</h1>
      <p className="mt-3 text-[color:var(--site-fg-subtle)]">
        没有找到「{slug}」对应的文档页。它可能尚未编写，或已在导航注册表中改名。
      </p>
      <p className="mt-3">
        <Link className="text-[color:var(--site-brand)]" to="/docs/welcome">
          返回「欢迎」
        </Link>
      </p>
    </article>
  );
}

function SidebarNav() {
  return (
    <nav aria-label="文档导航">
      {DOC_GROUPS.map((group) => (
        <div key={group.key} className="mb-6">
          <div className="mb-1.5 text-xs font-semibold tracking-wide text-[color:var(--site-faint)] uppercase">
            {group.title}
          </div>
          <ul>
            {group.pages.map((page) => (
              <li key={page.slug}>
                <Link
                  className="block rounded-md px-2 py-1 text-sm text-[color:var(--site-fg-subtle)] hover:bg-[color:var(--site-bg-soft)] hover:text-[color:var(--site-fg)]"
                  to={`/docs/${page.slug}`}
                >
                  {page.title}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

export function DocPage({ slug }: { slug: string }) {
  const meta = findDocPage(slug);
  const source = meta ? loadDocSource(slug) : undefined;
  const { prev, next } = docNeighbors(slug);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [slug]);

  return (
    <div className="mx-auto flex w-full max-w-6xl gap-10 px-4 py-8 sm:px-6">
      <aside className="sticky top-16 hidden h-[calc(100vh-4rem)] w-56 shrink-0 overflow-y-auto md:block">
        <SidebarNav />
      </aside>
      <main className="min-w-0 flex-1">
        <details className="mb-6 md:hidden">
          <summary className="cursor-pointer rounded-md border border-[color:var(--site-border)] px-3 py-2 text-sm">
            文档导航
          </summary>
          <div className="mt-3">
            <SidebarNav />
          </div>
        </details>
        {!meta || source === undefined ? (
          <DocNotFound slug={slug} />
        ) : (
          <article className="max-w-3xl">
            <h1>{meta.title}</h1>
            <p className="mt-1 mb-8 text-[15px] text-[color:var(--site-fg-subtle)]">
              {meta.description}
            </p>
            <Markdown source={source} />
            <div className="mt-14 flex items-center justify-between gap-4 border-t border-[color:var(--site-border)] pt-6 text-sm">
              {prev ? (
                <Link className="text-[color:var(--site-brand)]" to={`/docs/${prev.slug}`}>
                  ← {prev.title}
                </Link>
              ) : (
                <span />
              )}
              {next ? (
                <Link
                  className="text-right text-[color:var(--site-brand)]"
                  to={`/docs/${next.slug}`}
                >
                  {next.title} →
                </Link>
              ) : (
                <span />
              )}
            </div>
          </article>
        )}
      </main>
    </div>
  );
}

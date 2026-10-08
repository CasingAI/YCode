import { useEffect, useRef, useState } from "react";
import { useHashRoute, Link } from "./router.js";
import { useTheme } from "./theme.js";
import { DOWNLOAD_ASSETS, RELEASE_URL, UPSTREAM_URL } from "./links.js";
import { Home } from "./pages/Home.js";
import { DocPage } from "./pages/DocPage.js";
import { ChangelogPage } from "./pages/ChangelogPage.js";

// 站点图标取自仓库根的 icon-source-1024.png，public 目录随构建原样拷贝；
// 用 BASE_URL 拼相对路径，保证部署到子路径时也能解析。
const ICON_URL = `${import.meta.env.BASE_URL}icon.png`;

const NAV_LINK_CLASS =
  "rounded-md px-1.5 py-1.5 text-sm whitespace-nowrap text-[color:var(--site-fg-subtle)] hover:bg-[color:var(--site-bg-soft)] hover:text-[color:var(--site-fg)] sm:px-2.5";

function DownloadIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="h-3.5 w-3.5 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M8 2.5v7" />
      <path d="M5 7.2l3 3 3-3" />
      <path d="M3.5 13h9" />
    </svg>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={`h-3 w-3 shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 6.5l4 4 4-4" />
    </svg>
  );
}

function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={theme === "dark" ? "切换到亮色主题" : "切换到暗色主题"}
      className="rounded-md border border-[color:var(--site-border)] px-2.5 py-1.5 text-sm leading-none hover:bg-[color:var(--site-bg-soft)]"
    >
      {theme === "dark" ? "☀️" : "🌙"}
    </button>
  );
}

// 下载入口：按平台给直链，末尾留一条去 Releases 查全部版本与校验信息。
function DownloadMenu() {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="relative" ref={wrapperRef}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="inline-flex items-center gap-1.5 rounded-md bg-[color:var(--site-brand)] px-2.5 py-1.5 text-sm font-medium whitespace-nowrap text-white hover:opacity-90"
      >
        <DownloadIcon />
        下载
        <ChevronIcon open={open} />
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-1.5 w-60 overflow-hidden rounded-lg border border-[color:var(--site-border)] bg-[color:var(--site-bg)] py-1 shadow-lg"
        >
          {DOWNLOAD_ASSETS.map((asset) => (
            <a
              key={asset.url}
              role="menuitem"
              href={asset.url}
              onClick={() => setOpen(false)}
              className="flex items-baseline justify-between gap-3 px-3 py-2 text-sm hover:bg-[color:var(--site-bg-soft)]"
            >
              <span>{asset.platform}</span>
              <span className="text-xs text-[color:var(--site-faint)]">{asset.arch}</span>
            </a>
          ))}
          <div className="my-1 border-t border-[color:var(--site-border)]" />
          <a
            role="menuitem"
            href={RELEASE_URL}
            target="_blank"
            rel="noreferrer"
            onClick={() => setOpen(false)}
            className="block px-3 py-2 text-sm text-[color:var(--site-fg-subtle)] hover:bg-[color:var(--site-bg-soft)] hover:text-[color:var(--site-fg)]"
          >
            全部版本与更新说明
          </a>
          <p className="px-3 pt-1 pb-1.5 text-xs text-[color:var(--site-faint)]">
            当前提供 macOS 与 Windows 版，Linux 版暂未发布。
          </p>
        </div>
      ) : null}
    </div>
  );
}

function Header() {
  return (
    <header className="sticky top-0 z-10 border-b border-[color:var(--site-border)] bg-[color:var(--site-bg)]">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-1 px-4 sm:gap-4 sm:px-6">
        <Link className="flex shrink-0 items-center gap-2.5" to="/">
          <img src={ICON_URL} alt="" className="h-7 w-7 rounded-md" />
          <span className="text-[15px] font-bold tracking-tight">YCode</span>
          <span className="hidden text-xs text-[color:var(--site-faint)] sm:inline">
            自托管的 AI 编程工作台
          </span>
        </Link>
        <div className="flex items-center gap-1 sm:gap-2">
          <Link className={NAV_LINK_CLASS} to="/docs/welcome">
            文档
          </Link>
          <Link className={NAV_LINK_CLASS} to="/changelog">
            更新日志
          </Link>
          <ThemeToggle />
          <DownloadMenu />
        </div>
      </div>
    </header>
  );
}

function Footer() {
  return (
    <footer className="border-t border-[color:var(--site-border)]">
      <div className="mx-auto w-full max-w-6xl px-4 py-8 text-xs leading-relaxed text-[color:var(--site-faint)] sm:px-6">
        <p>
          YCode 基于 Apache-2.0 开源，上游项目是{" "}
          <a
            className="text-[color:var(--site-brand)]"
            href={UPSTREAM_URL}
            target="_blank"
            rel="noreferrer"
          >
            zai-org/ZCode
          </a>
          。数据流向与第三方组件声明见仓库内 NOTICE.md。
        </p>
        <p className="mt-1.5">
          「配置 / 技能 / 命令 / Hooks / MCP / 插件」等扩展机制页面改编自官方 zcode-guide
          插件（Apache-2.0），并以本仓库检出为准修订。
        </p>
      </div>
    </footer>
  );
}

export default function App() {
  const path = useHashRoute();

  let content;
  if (path === "/" || path === "") {
    content = <Home />;
  } else if (path === "/changelog" || path === "/docs/changelog") {
    content = <ChangelogPage />;
  } else if (path.startsWith("/docs/")) {
    content = <DocPage slug={path.replace(/^\/docs\//, "").replace(/\/+$/, "")} />;
  } else if (path === "/docs") {
    content = <DocPage slug="welcome" />;
  } else {
    content = <DocPage slug="__not_found__" />;
  }

  return (
    <div className="flex min-h-screen flex-col">
      <Header />
      <div className="flex-1">{content}</div>
      <Footer />
    </div>
  );
}

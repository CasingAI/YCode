import { useHashRoute, Link } from "./router.js";
import { useTheme } from "./theme.js";
import { Home } from "./pages/Home.js";
import { DocPage } from "./pages/DocPage.js";
import { ChangelogPage } from "./pages/ChangelogPage.js";

const UPSTREAM_URL = "https://github.com/zai-org/ZCode";
// 站点图标取自仓库根的 icon-source-1024.png，public 目录随构建原样拷贝；
// 用 BASE_URL 拼相对路径，保证部署到子路径时也能解析。
const ICON_URL = `${import.meta.env.BASE_URL}icon.png`;

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

function Header() {
  return (
    <header className="sticky top-0 z-10 border-b border-[color:var(--site-border)] bg-[color:var(--site-bg)]">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
        <Link className="flex items-center gap-2.5" to="/">
          <img src={ICON_URL} alt="" className="h-7 w-7 rounded-md" />
          <span className="text-[15px] font-bold tracking-tight">YCode</span>
          <span className="hidden text-xs text-[color:var(--site-faint)] sm:inline">
            自托管的 AI 编程工作台
          </span>
        </Link>
        <div className="flex items-center gap-2">
          <Link
            className="rounded-md px-2.5 py-1.5 text-sm text-[color:var(--site-fg-subtle)] hover:bg-[color:var(--site-bg-soft)] hover:text-[color:var(--site-fg)]"
            to="/docs/welcome"
          >
            文档
          </Link>
          <Link
            className="rounded-md px-2.5 py-1.5 text-sm text-[color:var(--site-fg-subtle)] hover:bg-[color:var(--site-bg-soft)] hover:text-[color:var(--site-fg)]"
            to="/changelog"
          >
            更新日志
          </Link>
          <ThemeToggle />
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

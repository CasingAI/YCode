import { useEffect, useState, type ReactNode } from "react";

// 站内 hash 路由：window.location.hash 是唯一事实源，
// 这里只做订阅投影，不维护第二份历史栈。

function currentPath(): string {
  const raw = window.location.hash.replace(/^#/, "");
  if (raw === "") return "/";
  return raw.startsWith("/") ? raw : "/";
}

export function useHashRoute(): string {
  const [path, setPath] = useState(currentPath);
  useEffect(() => {
    const onHashChange = () => setPath(currentPath());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  return path;
}

export function Link({
  to,
  className,
  children,
}: {
  to: string;
  className?: string;
  children: ReactNode;
}) {
  if (/^https?:\/\//.test(to)) {
    return (
      <a className={className} href={to} target="_blank" rel="noreferrer">
        {children}
      </a>
    );
  }
  return (
    <a className={className} href={`#${to}`}>
      {children}
    </a>
  );
}

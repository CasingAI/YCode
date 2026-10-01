import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "ycode-website-theme";

type Theme = "light" | "dark";

function resolveInitialTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // 无 localStorage 时直接跟随系统
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

// 运行时唯一事实源是 documentElement 的 dark class；
// localStorage 只保存用户的手动选择，未选择过则始终跟随系统。
export function useTheme(): { theme: Theme; toggleTheme: () => void } {
  const [theme, setTheme] = useState<Theme>(resolveInitialTheme);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next = prev === "dark" ? "light" : "dark";
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // 存不进去也允许本次切换生效
      }
      return next;
    });
  }, []);

  return { theme, toggleTheme };
}

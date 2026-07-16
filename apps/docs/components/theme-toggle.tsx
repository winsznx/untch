"use client";

import { useEffect, useState } from "react";

export type Theme = "dark" | "light";

const STORAGE_KEY = "untch-docs-theme";

function applyTheme(theme: Theme) {
  document.documentElement.setAttribute("data-theme", theme);
  document.documentElement.style.colorScheme = theme;
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("dark");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY) as Theme | null;
    const initial: Theme = stored === "light" || stored === "dark" ? stored : "dark";
    setTheme(initial);
    applyTheme(initial);
    setReady(true);
  }, []);

  function toggle() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    localStorage.setItem(STORAGE_KEY, next);
    applyTheme(next);
  }

  if (!ready) {
    return (
      <button type="button" className="theme-toggle" aria-label="Toggle theme" disabled>
        ···
      </button>
    );
  }

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={toggle}
      aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
      title={theme === "dark" ? "Light" : "Dark"}
    >
      {theme === "dark" ? "Light" : "Dark"}
    </button>
  );
}

/** Inline script for first paint (no flash). Place in <head>. */
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem('${STORAGE_KEY}');if(t!=='light'&&t!=='dark')t='dark';document.documentElement.setAttribute('data-theme',t);document.documentElement.style.colorScheme=t}catch(e){document.documentElement.setAttribute('data-theme','dark')}})();`;

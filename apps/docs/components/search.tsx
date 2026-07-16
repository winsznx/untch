"use client";

import { useMemo, useState } from "react";
import type { SearchEntry } from "@/lib/content";

export function SearchBox({ index }: { index: SearchEntry[] }) {
  const [q, setQ] = useState("");
  const hits = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (term.length < 2) return [];
    return index
      .filter((e) => e.text.includes(term) || e.title.toLowerCase().includes(term))
      .slice(0, 8);
  }, [q, index]);

  return (
    <div className="search-wrap">
      <input
        type="search"
        placeholder="Search docs…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        aria-label="Search documentation"
      />
      {hits.length > 0 ? (
        <div className="search-results" role="listbox">
          {hits.map((h) => (
            <a key={h.slug} href={h.href} onClick={() => setQ("")}>
              <div className="hit-title">{h.title}</div>
              {h.description ? <div className="hit-desc">{h.description}</div> : null}
            </a>
          ))}
        </div>
      ) : null}
    </div>
  );
}

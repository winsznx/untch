import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import Link from "next/link";

const components: Components = {
  a({ href, children }) {
    if (!href) return <span>{children}</span>;
    const external = href.startsWith("http") || href.startsWith("mailto:");
    if (external) {
      return (
        <a href={href} target="_blank" rel="noopener noreferrer">
          {children}
        </a>
      );
    }
    // Internal docs links: /quickstart, /concepts/policy
    return <Link href={href}>{children}</Link>;
  },
  // Avoid raw HTML; keep tables/code from GFM.
};

export function Markdown({ source }: { source: string }) {
  return (
    <div className="prose">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {source}
      </ReactMarkdown>
    </div>
  );
}

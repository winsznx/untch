import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import Link from "next/link";

const ADDR_RE = /^0x[a-fA-F0-9]{40}$/;

/** Known testnet base contracts → testnet explorer; everything else full-address → mainnet. */
const TESTNET_ADDRS = new Set(
  [
    "0xe1d74c90801db0fa806c72eb818b7671b8233532",
    "0xf87e50f83172c2dace7d274e4c701212caeb1372",
    "0x0c64997277b7d94d2999dea22a123cac56334863",
    "0x1562c6eb1813016c8562cf6771cbf715007bb7e9",
    "0x42e699ffd8215d48397a049b4f7a176db06f4848",
    "0xf202ce41d76ee1a2aec72e7a9180331d437ddd41",
  ].map((a) => a.toLowerCase()),
);

function explorerUrl(addr: string): string {
  const lower = addr.toLowerCase();
  const base = TESTNET_ADDRS.has(lower)
    ? "https://www.oklink.com/x-layer-testnet"
    : "https://www.oklink.com/x-layer";
  return `${base}/address/${addr}`;
}

function textOf(children: React.ReactNode): string {
  if (typeof children === "string") return children;
  if (Array.isArray(children)) return children.map(textOf).join("");
  if (children && typeof children === "object" && "props" in (children as object)) {
    return textOf((children as { props?: { children?: React.ReactNode } }).props?.children);
  }
  return "";
}

const components: Components = {
  /**
   * Every table gets its own horizontal scroll container.
   *
   * Several docs tables carry four columns of 42-character addresses. Without a wrapper the widest
   * one sets the width of the article, the article widens the body, and the whole PAGE scrolls
   * sideways on a phone — which reads as a broken layout rather than as a wide table. Wrapped, the
   * table scrolls inside itself and nothing else moves.
   */
  table({ children, ...props }) {
    return (
      <div className="table-wrap">
        <table {...props}>{children}</table>
      </div>
    );
  },
  a({ href, children }) {
    if (!href) return <span>{children}</span>;
    const external = href.startsWith("http") || href.startsWith("mailto:");
    if (external) {
      return (
        <a href={href} target="_blank" rel="noopener noreferrer" className="addr-link">
          {children}
        </a>
      );
    }
    return <Link href={href}>{children}</Link>;
  },
  code({ className, children, ...props }) {
    const raw = textOf(children).trim();
    // Bare address in inline code (not fenced block): make explorer-clickable when not already a link child
    const isBlock = Boolean(className?.includes("language-"));
    if (!isBlock && ADDR_RE.test(raw)) {
      return (
        <a
          href={explorerUrl(raw)}
          target="_blank"
          rel="noopener noreferrer"
          className="addr-link"
          title="Open on OKLink"
        >
          <code {...props}>{children}</code>
        </a>
      );
    }
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  },
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

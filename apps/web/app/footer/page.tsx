import type { Metadata } from "next";
import { SiteFooter } from "../../components/site-footer";

export const metadata: Metadata = {
  title: "Untch footer — review",
  description: "Visual review page for the Untch site footer.",
};

export default function FooterReview() {
  return (
    <main className="flex min-h-screen flex-col justify-between bg-canvas">
      <div className="mx-auto max-w-page px-6 py-24">
        <h1 className="text-heading" style={{ color: "var(--color-text)" }}>
          Footer review
        </h1>
        <p className="mt-4 max-w-2xl text-body" style={{ color: "var(--color-inverse-canvas)" }}>
          The footer is below, on its specified Iris Glow background. Only the background color was
          specified in the design files; the columns, links, and content are a new decision within the
          token system (see the master review doc and apps/web/README.md).
        </p>
      </div>
      <SiteFooter />
    </main>
  );
}

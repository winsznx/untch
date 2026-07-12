# @untch/web

Untch web app. Routes:

- `/` — the assembled homepage (header, hero, problem, loop, modes, live proof, social proof, CTA, footer).
- `/dashboard` — operator dashboard (sidebar links to all §15 screens).
- `/explorer` — public receipts explorer.
- `/internal/tokens` — the design-token specimen (internal reference, not product navigation).
- `/header` `/hero` `/cta` `/social-proof` `/footer` — per-component review routes.

The full decision log (what's faithful to spec, every new decision and its reasoning, what's real
data vs placeholder, per component) lives in the master review document at
`internal/frontend-review.md`. Read that first for review.

## Run the review pages

```
pnpm install
pnpm --filter @untch/web dev
# token specimen:  http://localhost:3000
# header / nav:     http://localhost:3000/header
```

Or build and serve the production output:

```
pnpm --filter @untch/web build
pnpm --filter @untch/web start
```

To see the mobile collapse, narrow the window under 768px on the `/header` page (or use the
browser dev-tools device toolbar).

## Header / navigation component

Source: `components/site-header.tsx`. Reviewable at `/header`.

Header and nav are one component. The Impilo comprehension report (`internal/design.md`,
"Navigation Bar (Dark)") describes a single top bar and gives no separate header spec, so this
is one unified piece.

Every visual value references `@untch/design-tokens` — colors, the type roles (`text-body`
17px/500, `text-title-sm` 24px/600), the 4px-base spacing utilities, and the `rounded-buttons`
pill radius. There are no raw hex or px values duplicating a token. The single raw px is the
80px bar height, which is a nav-specific dimension the token scale has no entry for; it lives as
one named constant (`NAV_HEIGHT_PX`) and is flagged in the source.

### Faithful to spec (applied directly from design.md and the do/don't list)

- Deep Iris canvas background, 80px height, logo left, center links, pill CTA right.
- Nav-link and CTA text at the settled body role (17px, weight 500).
- 9999px pill radius on the CTA — the non-negotiable "pill on all buttons" rule.
- No shadow on the nav pill on the dark canvas (`tokens.ts` `elevationRules`).

The bar is sticky and filled with the Deep Iris canvas color. The spec says
"transparent / Deep Iris-canvas background"; on a Deep Iris page those look identical, and the
solid canvas fill is what keeps a sticky bar readable over scrolled content. Impilo's dropdown
arrows are dropped — Untch's links are direct, with no submenus.

### Five open decisions (Impilo's spec answers none of these — proposed, flagged, not invented silently)

1. **Logo — NEW DECISION, confirm.** A text wordmark "Untch" at the title role (24px/600), as an
   explicit placeholder. No Untch mark exists yet; this needs a designed logo eventually.

2. **Nav links — NEW DECISION, confirm.** `Product`, `Receipts`, `Docs`, `Pricing`. Grounded in
   what is actually true about Untch, not generic About/Contact filler:
   - `Product` — the product / how-it-works page.
   - `Receipts` — the public receipts explorer (PRD S6), a real, distinctive Untch surface.
   - `Docs` — docs live on Mintlify per the confirmed environment architecture (external once live).
   - `Pricing` — real per-call tool prices (PRD §11) plus the A2A audit SKUs (PRD S2).

3. **Primary CTA — NEW DECISION, confirm.** "Create a spend policy" — the PRD's own canonical
   primary CTA — replacing Impilo's "Request Demo", which does not fit a product with no
   demo-booking flow. Plain language, no filler.

4. **Mobile collapse — NEW DECISION, confirm.** No responsive data exists in either source file.
   Below 768px (Tailwind's `md` breakpoint) the center links and CTA collapse into a hamburger
   menu, built from the same tokens (Deep Iris surface, hairline border, the pill CTA), not an
   ad-hoc mobile-only style island. The hamburger morphs to a close icon; Escape and link taps
   close the menu; it is keyboard-reachable and labelled (`aria-expanded` / `aria-controls`).

5. **Motion — NEW DECISION, confirm.** Nothing is specified anywhere in the source docs. Small,
   systematic motion consistent with the sparse, hard-cut aesthetic: 150ms transitions, nav
   links lift on hover (opacity), the CTA lifts on hover (brightness — no shadow, per spec), the
   mobile menu opens with a quick fade-and-slide. `prefers-reduced-motion` disables the
   transitions.

### Placeholder / pending

- **Logo** is a text wordmark placeholder — it needs a real designed mark.
- **All link and CTA destinations are structurally correct but the pages do not exist yet:**
  `/product`, `/receipts`, `/docs` (will point at the Mintlify docs site), `/pricing`, and
  `/app` (the CTA target — the operator dashboard, S5). They will 404 until those pages are built.

## Dashboard data — read side (real, shared Postgres) + the write-sync gap

**Read side (wired).** The policy list, intent stream, ledger, escalation inbox, and vendor/buyer scores
read the SAME shared Railway Postgres the seller (`@untch/asp`), receipt writer, escalation service, and
Bureau write to in production — via the proven pg repos (`PgPolicyRepo`, `PgReportDataSource`,
`PgEscalationsRepo`, `PgScoreDataSource`), never a second query implementation. Every read is scoped to the
signed-in wallet: `getScope()` gives the address, `lib/dashboard/db.ts` resolves that owner's agents from the
`policies` table, and `lib/dashboard/live.ts` reads per agent. No `DATABASE_URL` (local/CI) ⇒ honest empty
state, never a global unscoped read. Verified end to end: a policy created via the live seller's
`create_spend_policy` for the demo operator's wallet appears in the dashboard when signed in as that wallet.

**Still NOT fixed — the write-sync gap (next real item, deliberately out of scope here):** a policy/intent
created via the dashboard's OWN wallet flow (a `registerPolicy` tx signed directly on-chain, `TxButton` →
`useWallet.writeContract`) still won't appear anywhere, because nothing records a dashboard-originated write
into the shared Postgres, and the dashboard doesn't re-read the PolicyRegistry from chain afterward. The read
path shows what the SELLER's tools persist; a dashboard-only write lands on-chain but not in Postgres, so the
list won't reflect it until the seller's create/update path (or a chain-indexer) writes it. This is a genuine
separate problem — the write leg of the same "one durable store" story — and deserves its own scoped change
(have the dashboard write go through the seller's policy-store path, or index PolicyRegistry events into
Postgres), not an inline patch.

A related, smaller write-side item: dashboard-native escalation **approve/deny**. The inbox now READS real
escalations, but resolving one from the dashboard needs the dashboard registered as a §27 control channel
(its approvals config + session-carried authority at creation) — a seller-created escalation's single-use
code lives only in the sent message, so the dashboard cannot redeem it today. Resolution currently happens
through the bound channels (Telegram / Discord / Slack); the inbox shows each escalation's real status.

## Stack

Next.js 16.2.10, React 19.2.7, Tailwind CSS v4.3.2. Fonts (Manrope primary, Plus Jakarta Sans
fallback) are self-hosted through `next/font`, so there are no runtime external font requests.
Tokens come from `@untch/design-tokens`; read that package's README for the full token reference,
the Gilroy-to-Manrope font caveat, the color semantic remapping, and the open flags still pending
owner confirmation.

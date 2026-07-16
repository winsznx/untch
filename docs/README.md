# Untch documentation

Source of truth for **docs.untch.xyz**.

Content lives here as MDX (Markdown + frontmatter). The site is a self-hosted Next app at `apps/docs` that reads this folder. No Mintlify account required.

## Local preview

From repo root:

```bash
pnpm install
pnpm --filter @untch/docs dev
```

Open http://localhost:3002

## Deploy (Railway)

1. Create a service named **`untch-docs`** in the untch project (root directory = monorepo root).
2. `railway.json` builds and starts with:
   - build: `pnpm --filter @untch/docs build`
   - start: `pnpm --filter @untch/docs start`
3. Attach custom domain **docs.untch.xyz** to that service.
4. DNS: CNAME `docs` → Railway domain (or A/AAAA per Railway UI).

## Content rules

- Plain technical prose. No filler openers.
- No em dashes. Use periods, commas, or parentheses.
- Tables for parallel facts (endpoint, price, status).
- Link live surfaces: www.untch.xyz, asp.untch.xyz, OKLink.
- Document honest limits (Mode D roadmap, writer timelock).

## Layout

```text
docs/
  docs.json          # nav groups + site chrome links
  index.mdx
  quickstart.mdx
  what-untch-is.mdx
  concepts/
  operators/
  agents/
  reference/
  security/

apps/docs/           # Next renderer (owned)
```

Edit MDX here; the app picks up pages listed in `docs.json` navigation.

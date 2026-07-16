# Untch documentation source

Mintlify site source for **docs.untch.xyz**.

## Local preview

```bash
# from repo root
cd docs
npx mintlify dev
```

Requires Node 18+. First run may prompt to install the Mintlify CLI.

## Deploy

1. Connect this repo (or the `docs/` folder) to [Mintlify](https://mintlify.com).
2. Set custom domain `docs.untch.xyz` (CNAME per Mintlify DNS instructions).
3. Push to the tracked branch. Mintlify builds from `docs.json` + MDX pages.

## Writing rules

- Plain technical prose. No filler openers.
- No em dashes. Use periods, commas, or parentheses.
- Tables for parallel facts (endpoint, price, status).
- Link to live surfaces: www.untch.xyz, asp.untch.xyz, OKLink.
- Document honest limits (Mode D roadmap, free-tier stubs, writer timelock).

## Layout

```text
docs/
  docs.json          # Mintlify config + navigation
  index.mdx          # Home
  quickstart.mdx
  what-untch-is.mdx
  concepts/
  operators/
  agents/
  reference/
  security/
```

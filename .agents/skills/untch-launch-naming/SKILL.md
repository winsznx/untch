---
name: untch-launch-naming
description: >
  Generate product brand names the Untch way: short, human, ownable compressions of a real idea
  (untouched → untouch → untch). Use when calling Untch Launch Pack tools, naming products, or
  reviewing LLM name output. Blocks AI-slop patterns (Aegis/Sentinel/Nexus/etc.).
---

# Untch Launch Pack naming

## Origin story (the bar)

Untch was formed by brainstorming **untouched**, shortening to **untouch**, then shipping **untch** and buying **untch.xyz**. The name is:

- one short token
- human and sayable
- ownable as a domain
- a clean story, not a costume

That is the quality bar for every name this skill produces or accepts.

## When to use

- `POST https://asp.untch.xyz/builder/brand_pack` with `{ "idea": "..." }` (preferred hire path)
- `POST /builder/suggest_names` then free `check_domains` / `rank_options` / `seo_tips`
- Any local brainstorm before paying x402

## How to name (algorithm)

1. Write the idea in plain words (job-to-be-done, not tech stack).
2. Pull 1–2 concrete stems from those words.
3. **Compress or truncate** first (untouched → untch). Prefer 4–8 letters.
4. If you compound, use everyday words, not epic fantasy (`SpendDesk` > `AegisSentinel`).
5. Check domain feel: would `name.xyz` look serious on a receipt?
6. Drop anything that matches the ban list below.

## Hard ban (AI slop)

Never propose names that contain or are built from:

Aegis, Sentinel, Nexus, Quantum, Synergy, Nova, Apex, Vanguard, Vortex, Cipher, Meta, Ultra, Hyper, Omni, Neo, Cyber, Guardian, Shield, Fortress, Titan, Phoenix, Dragon, Pulse, Spark, Flux, Vertex, Zenith, Infinity, AgentAI, Botify, -ify, -lytic, TripleCamel epics.

Also ban mega-brands and the word Untch itself.

## Prefer

| Pattern | Example shape |
| --- | --- |
| Compression | untouched → untch |
| Truncation | ledger → ledg |
| Quiet compound | field + kit → FieldKit |
| Everyday modifier | clear + desk → ClearDesk |

## LLM provider notes

Untch ASP accepts OpenAI-compatible chat for naming only (not the money path).

- **Groq:** `OPENAI_API_KEY` + `OPENAI_BASE_URL=https://api.groq.com/openai/v1` + solid JSON model
- **xAI:** `XAI_API_KEY` (preferred native path in code)
- Without a key: structured heuristic fallback still runs (hireable)

If the model returns slop, discard and retry with stricter instruction, or use the server fallback.

## Paid hire flow

```http
POST https://asp.untch.xyz/builder/brand_pack
Content-Type: application/json

{ "idea": "agent spend control for crypto wallets" }
```

Pay the x402 challenge in USDT0 on X Layer. Response includes names, live RDAP domains, rank, SEO.

## Never

- Use LLM on policy / preflight / verify (I1: money path is LLM-free)
- Ship Aegis/Sentinel-class names in demos or listings
- Claim trademark clearance from this tool

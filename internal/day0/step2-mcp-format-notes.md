# Step-2 — Does an OKX.AI A2MCP listing need an MCP protocol wrapper beyond a plain x402 HTTP route?

**Question (verbatim from the Step-2 prompt):** does OKX.AI's A2MCP listing format require a
specific MCP protocol wrapper — tool manifest / schema publication, JSON-RPC-style tool-calling —
*beyond* what D0.1 already proved (a plain x402-priced HTTP route)?

**Short answer: NO seller-side MCP protocol wrapper is required.** A plain x402-priced HTTP route —
exactly the shape D0.1 shipped and this step extends (`ping_untch`, and now `create_spend_intent` /
`preflight_payment`) — is sufficient at the protocol/wire level to be an A2MCP seller. The MCP
tool that "wraps" the call is a **buyer-side** construct, not something the seller hosts. **One
residual, listing-time (not build-time) unknown remains** — whether OKX's registration *form* asks
you to submit a declarative tool schema (name/description/input/output) as marketplace metadata —
flagged in §4 as a D0.2 follow-up, NOT built here.

**Date:** 2026-07-09 · **Method discipline:** same as the D0.1 notes — every line is tagged
**[VERIFIED · <source>]** (read from an authoritative source this session) or **[UNVERIFIED]**
(not confirmable because the primary doc host is unreachable from here). Reachability is unchanged
from D0.1: `web3.okx.com` / `www.okx.com` / `github.com` are HTTP 000 from the operator's Nigerian
egress AND are blocked from claude.ai's hosted WebFetch egress ("domain … not safe to fetch"), so
the OKX dev-docs and the `okx/onchainos-skills` repo could not be read directly. Search-engine
summaries of the authoritative sources (OKX APP whitepaper v1.0; OKX Learn) WERE reachable.

---

## 1. The decisive finding — A2MCP's seller side is "plain HTTP", the MCP tool is buyer-side

- **[VERIFIED · OKX Agent Payments Protocol Whitepaper v1.0 (April 2026), via search summary]**
  Verbatim on the A2MCP shape: *"A Seller may be another Agent reachable over an IM network (the
  A2A shape) or a priced HTTP service or tool the Buyer Agent consumes — often reached through an
  **MCP tool on the Agent side** (the A2MCP shape). **The payment rail here is plain HTTP.**"*
- **[VERIFIED · same whitepaper]** *"The Seller is an **HTTP-addressable service**, often
  discovered and invoked through an **MCP tool on the Buyer Agent's side**. When the Agent hits a
  priced endpoint, the service returns an Agent Payments Protocol challenge over HTTP — typically
  as an x402-style 402 Payment Required carrying a challenge URL."*
- **Reading of the two quotes:** the "MCP" in **A2**MCP names *where the buyer's call originates*
  (the buyer agent invokes the seller **through an MCP tool in its own runtime**, e.g. the MCP host
  issues JSON-RPC to a buyer-side MCP server which in turn makes the priced HTTP call). It does
  **not** require the **seller** to speak Model Context Protocol. The seller's obligations are the
  x402 ones D0.1 already discharged: return a 402 `PAYMENT-REQUIRED` challenge, accept the
  `PAYMENT-SIGNATURE`, return the resource + `PAYMENT-RESPONSE`. Nothing more at the wire level.

**Therefore:** no `tools/list`, no `tools/call`, no JSON-RPC 2.0 server, no hosted `.well-known`
tool manifest is required *on the seller* to be A2MCP-callable. Confidence: **HIGH** (explicit in
the primary protocol spec, corroborated by two independent OKX Learn summaries).

## 2. Why this was a real question and not already answered by D0.1

D0.1 proved a different thing: that a plain x402 route can **settle a real payment** through OKX's
hosted facilitator. It did not, by itself, establish whether being **listed** in the OKX.AI
marketplace as an A2MCP provider demands an extra protocol surface (the literal "MCP" in "A2MCP"
makes that a reasonable worry — MCP is a JSON-RPC protocol). The finding above closes that worry
at the protocol level: the marketplace's discovery/MCP-exposure layer is OKX's, not the seller's.

- **[VERIFIED · OKX Learn "okx-ai" summary]** *"The OKX.AI marketplace enables MCPs to be hosted
  and exposed through A2MCP workflows."* — i.e. the marketplace **exposes** the tool as an MCP tool
  to buyers; the provider supplies an HTTP service + metadata, not a hosted MCP server.

## 3. Registration = submit service details for review (a form, not a protocol)

- **[VERIFIED · OKX Learn "okx-ai" summary]** To join as a provider: *"set up your Agentic Wallet
  and install the required Onchain OS skill. Register as an Agent Service Provider (ASP), select
  either escrow-based (A2A) or pay-per-call (A2MCP) mode, and **submit your service details for
  review by OKX**."* The gate to being listed is a **metadata submission + OKX review**, not a
  protocol conformance check against a hosted MCP endpoint. (Consistent with D0.1's finding that
  the raw x402 *call* needs no ASP approval, but a marketplace **listing** does go through OKX
  review — that review is of submitted details, this is the D0.2 workstream.)

## 4. The one residual UNKNOWN — flagged for D0.2, explicitly NOT built in this step

- **[UNVERIFIED — the only open item]** Whether OKX's live A2MCP registration form requires a
  **declarative tool schema** as a submitted field — i.e. per-tool `name`, `description`, and
  input/output **JSON schema** — as marketplace metadata. Our own D0.2 field-capture template
  (`internal/day0/D0.2-listing/field-capture.md`, still blank) has a section 5 ("Tool registration
  and pricing (A2MCP)") that asks exactly this: *"How is a tool registered (endpoint URL, schema
  upload, manual entry)… Per-tool fields captured (name, description, input schema, output
  schema)."* That section is unfilled because nobody has walked the live UI (it is gated behind
  the same unreachable host).
- **Crucial distinction:** even in the worst case, that is a **declarative schema you type/upload
  into OKX's form**, describing your existing HTTP tool — **not** a JSON-RPC MCP server you must
  stand up and host. The effort if required is "write two small JSON schemas for
  `create_spend_intent` / `preflight_payment` inputs+outputs at listing time" (cheap, declarative),
  not "implement Model Context Protocol on the seller."
- **Decision for THIS step:** out of scope, do not build. The prompt scoped Step-2 to building the
  two endpoints as x402 HTTP routes; per its instruction, this gap is flagged, not filled. Action
  item lands in D0.2: when the live OKX A2MCP registration UI becomes reachable, fill field-capture
  §5 and, if a per-tool input/output JSON schema is a required field, author those two declarative
  schemas then.

## 5. Bottom line for the build

| Concern | Verdict | Confidence |
|---|---|---|
| Seller must implement MCP (JSON-RPC, `tools/list`/`tools/call`) | **No** | HIGH (whitepaper explicit) |
| Seller must host a `.well-known` / tool-manifest endpoint | **No** | HIGH (buyer-side MCP; "payment rail is plain HTTP") |
| Plain x402-priced HTTP route is a valid A2MCP seller | **Yes** — this is D0.1's shape | HIGH |
| Listing needs a metadata submission + OKX review | **Yes** (D0.2, a form) | HIGH |
| Registration form requires a *declarative* per-tool input/output JSON schema field | **Unknown** — flag for D0.2 | UNVERIFIED |

**Net: build the two endpoints as plain x402 HTTP routes (this step). No MCP wrapper now.** The
only thing that could ever be needed is declarative schema *metadata* at listing time, and that is
a D0.2 form-filling task, not a protocol layer — confirm it against the live UI before authoring.

---

## Sources read this session
- OKX Agent Payments Protocol **Whitepaper v1.0** (`web3.okx.com/whitepaper/okx-app-whitepaper.pdf`)
  — authoritative protocol spec; read via search-engine summary (host unreachable for direct fetch).
- OKX Learn: `okx.com/learn/okx-ai`, `okx.com/learn/agent-payments-protocol` — via search summaries.
- `mcpservers.org/agent-skills/okx/okx-ai-guide` — mirror of OKX's `okx-ai-guide` skill (reachable,
  but the excerpt was onboarding-level and did not add protocol detail).
- Direct WebFetch of `web3.okx.com/*` and `github.com/okx/onchainos-skills` — **BLOCKED** from
  claude.ai egress ("domain not safe to fetch"); recorded here so the method is auditable.
- Reconciled against D0.1's own notes (`D0.1-payment-sdk-notes.md`) — raw x402 needs no ASP
  approval; listing does go through OKX review; both consistent with the above.

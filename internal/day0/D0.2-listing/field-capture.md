# D0.2 — Field capture template (fill while walking the real OKX.AI ASP flow)

**Gate:** §29 D0.2 — capture required fields plus review requirements from the live registration UI.
**How to use:** open the OKX.AI ASP registration flow and fill every blank below as you go. Record what the UI actually shows, not what you expect. If a field is not present, write "not present". If a section does not appear at all, write "section absent". Do not skip anomalies.
**Do not:** submit or register anything during capture. This is a dry-run inventory only.

---

## 0. Session metadata

- Date walked:
- Account / wallet used to reach the flow:
- Entry URL (where the ASP registration flow starts):
- Access gate before the form (login, wallet connect, allowlist, waitlist):
- A2MCP vs A2A: is the listing type chosen up front, or does one form cover both?

---

## 1. Flow map (ordered steps / screens)

List each screen in order as you move through the flow. One row per screen.

| # | Screen / step name (verbatim) | Purpose | Can you go back and edit? |
|---|-------------------------------|---------|---------------------------|
| 1 | | | |
| 2 | | | |
| 3 | | | |
| 4 | | | |
| 5 | | | |
| 6 | | | |

---

## 2. Field inventory (one row per input on every screen)

Capture every field the flow presents. Add rows as needed.

| # | Screen | Field label (verbatim) | Required? | Type (text / long text / dropdown / multiselect / toggle / upload / number) | Character limit (min / max) | Allowed values or format | Placeholder / default shown | Notes |
|---|--------|------------------------|-----------|------------------------------------------------------------------------------|-----------------------------|--------------------------|-----------------------------|-------|
| 1 | | | | | | | | |
| 2 | | | | | | | | |
| 3 | | | | | | | | |
| 4 | | | | | | | | |
| 5 | | | | | | | | |
| 6 | | | | | | | | |
| 7 | | | | | | | | |
| 8 | | | | | | | | |
| 9 | | | | | | | | |
| 10 | | | | | | | | |
| 11 | | | | | | | | |
| 12 | | | | | | | | |
| 13 | | | | | | | | |
| 14 | | | | | | | | |
| 15 | | | | | | | | |
| 16 | | | | | | | | |
| 17 | | | | | | | | |
| 18 | | | | | | | | |
| 19 | | | | | | | | |
| 20 | | | | | | | | |

---

## 3. Category / classification

- Is a category field present?
- Full list of category options offered (copy verbatim):
- Single-select or multi-select?
- Is "Finance" available?
- Is "Software services" (or equivalent) available?
- Any tags / keywords field, and its limit:

---

## 4. Uploads and assets

One row per upload the flow accepts.

| Asset (logo / banner / cover / demo video / other) | Required? | Accepted formats | Dimensions / aspect ratio | Max file size | Notes |
|----------------------------------------------------|-----------|------------------|---------------------------|---------------|-------|
| | | | | | |
| | | | | | |
| | | | | | |

- Is a demo link / walkthrough URL requested? Required?:
- Is an X (Twitter) post link requested? Required?:
- Is a docs / website / repo URL requested? Required?:

---

## 5. Tool registration and pricing (A2MCP)

- How is a tool registered (endpoint URL, schema upload, manual entry, other):
- Per-tool fields captured (name, description, input schema, output schema, other):
- How is price set (per-tool, per-listing, fixed field, free-text):
- Price unit and settlement token shown (USDT, USDG, other):
- Minimum price allowed / decimals granularity:
- Is a free-tier / free-call setting configurable in the UI?:
- Is idempotency / requestId handling mentioned anywhere?:

---

## 6. Payment SDK verification

- Does the flow require Payment SDK integration proof before listing?:
- What exactly is checked (test call, health check, signature, credential entry, other):
- Credentials or keys the form asks for:
- Is a successful settled call required before the listing can go live?:
- Error / status shown when verification fails:
- Does it reference OKX Agent Payments Protocol, x402, MPP, or a2a-pay by name?:

---

## 7. Review criteria shown in the UI

Copy verbatim any on-screen text describing what the review checks or expects.

- Review criteria text shown:
- Any checklist / requirements list displayed before submit:
- Any content rules or prohibited-content notice shown:
- Any eligibility statement shown (who can list):

---

## 8. Review SLA / timeline

- Is a review time / SLA stated?:
- Stated value (hours / days):
- Notification method for approval or rejection:
- Is resubmission after rejection allowed, and how:
- Does the listing go live automatically on approval, or need a manual publish step:

---

## 9. Submission and confirmation

- What the final submit button says (verbatim):
- Confirmation screen text:
- Listing URL / ID assigned (structure only, not the value):
- Post-submit editability (can fields be changed after submission):
- Status states shown after submit (pending / in review / live / rejected):

---

## 10. Screenshots to take (check off as captured)

- [ ] Entry / landing screen of the ASP registration flow
- [ ] Access gate (login / wallet connect / allowlist) if present
- [ ] Listing-type selection (A2MCP vs A2A) if present
- [ ] Each screen of the flow, full page, before filling
- [ ] Every field with visible character-limit counter or validation hint
- [ ] Category dropdown fully expanded showing all options
- [ ] Upload requirements panel (formats, sizes, dimensions)
- [ ] Tool registration screen and pricing input
- [ ] Payment SDK verification step and its success / failure state
- [ ] Any review-criteria or requirements text shown before submit
- [ ] Any content-rules or prohibited-content notice
- [ ] Review SLA / timeline text if shown
- [ ] Final submit button and confirmation screen
- [ ] Post-submit status screen and assigned listing URL / ID

---

## 11. Anomalies and open questions

- Fields that were unclear or ambiguous:
- Anything that differs from the PRD assumptions (§11 tool set, §19 form package, §23 Q3):
- Anything that blocks listing today:
- Follow-ups to raise in the X Layer Builder Hub:

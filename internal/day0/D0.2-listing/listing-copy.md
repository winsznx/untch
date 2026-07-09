# D0.2: Listing copy (submission-ready)

**Gate:** §29 D0.2 (ASP listing dry-run). This file holds the final paste-ready copy for both OKX.AI listings.
**Source of truth:** untch-prd.md Brand & naming, §1, §5, §11, §17, §24.
**Style contract:** no em-dashes, no hedging words, plain confident sentences. Ranges written as "X to Y USDT".
**Usage:** copy each labeled block straight into the matching OKX.AI form field. Match field names and character limits against field-capture.md once the real flow is captured.

---

## Listing #1: Untch (A2MCP, pay-per-call)

### Display name
```
Untch
```

Extended display name (use if the name field allows more characters):
```
Untch: Spend Control for Agents
```

### One-liner
```
Untch is the control plane for autonomous agent money: every payment is policy-checked before execution against a bounded intent, verified on delivery against a declared proof tier, and receipted on X Layer.
```

### Short description (108 words)
```
You want to fund an autonomous agent without letting it waste your money or get drained by a bad counterparty. Untch is the control plane that makes agent spend safe to fund. Every payment is checked against a bounded intent before it executes: the budget holds, the vendor is trusted, the call is not a duplicate, and the amount stays under policy. Delivery is verified against a declared proof tier before funds count as earned. Every decision is receipted on X Layer, so you can prove exactly what your agent spent and why. Your agent requests the spend. The policy engine decides. The model never touches the money.
```

### Category suggestion
```
Primary: Finance
Secondary: Software services
```

### Launch tools and prices
```
preflight_payment      0.05 USDT per call    Check a payment against policy before it executes. Returns the decision, the reasons, the full rule trace, and a receipt reference.
verify_delivery        0.10 USDT per call    Verify a delivery against its declared proof tier. Returns tier results, the final pass or fail, any diffs, and a receipt reference.
score_vendor           0.20 USDT per call    Score a vendor on receipt-backed reliability. Returns score, uncertainty, lower-confidence bound, band, top features, and the epoch root.
reconcile_agent_spend  0.25 USDT per day, 1.00 USDT per week    Produce a spend reconciliation report for an agent over a period. Returns the report artifact and its anchor transaction.
```

### Free tier
```
The first 20 preflights are free for every new agent.
```

### Tagline
```
The model never touches the money.
```

---

## Listing #2: Untch Audit Line (A2A, negotiated escrow)

### Display name
```
Untch Audit Line
```

### One-liner
```
Untch Audit Line delivers receipt-backed spend audits, vendor trust reports, and CFO reports for autonomous agents, each one anchored on X Layer so the findings are independently verifiable.
```

### SKUs

**Spend Leak Audit** (5 to 10 USDT)
```
We scan your agent's payment history for duplicate calls, wasted spend, high-risk vendors, and payments that went out unchecked. You receive a ranked list of every leak with the receipt behind it and the amount you recover by closing it.
```

**Vendor Trust Report** (5 to 15 USDT)
```
We score every vendor your agent pays using receipt-backed reliability signals and surface the risk driver behind each score. The report is anchored on X Layer, so the scores are independently verifiable rather than a private opinion.
```

**Agent CFO Report** (10 to 20 USDT)
```
We produce a full financial picture for the period: total spend, ROI, blocked waste, buyer hygiene, and concrete recommendations to tighten policy. The report is anchored on X Layer and links every figure back to its underlying receipts.
```

### Tagline
```
The model never touches the money.
```

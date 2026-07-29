# Untch public copy standard

Everything a person reads should sound like an engineer telling them what happened. Not a brochure,
not a manifesto, and not a language model doing an impression of either.

This is enforced by `pnpm lint:public-copy`, which fails CI. The rules below are the rules the linter
checks. Where a rule cannot be checked mechanically it says so, and stays a review expectation.

---

## 1. What this covers

| In scope | Why |
| --- | --- |
| Website pages and dashboard text | The main thing people read |
| Empty states, success messages, error explanations | The moments where tone matters most |
| Emails Untch generates | Untch is the author, so Untch owns the words |
| Receipt descriptions | A receipt is a public artifact |
| Marketing docs, README, changelog entries | Read by people deciding whether to trust the project |
| Demo fixture messages | They get screenshotted |
| Provider-facing descriptions, OKX.AI listing drafts | Public claims about what works |
| Social copy drafts | Same, with less room to hedge |

| Out of scope | Why |
| --- | --- |
| Machine-readable error codes (`PAYMENT_AMBIGUOUS`) | A code is an identifier, not prose |
| Provider responses quoted exactly | Editing a quotation makes it a misquotation |
| Source code and code comments | Written for engineers reading the code, a different audience |
| Transaction hashes, addresses, protocol field names | Data |
| Legal text that must remain exact | Exactness beats style |
| Text a user supplied | Not ours to rewrite |

The precise file globs are in `scripts/lint-public-copy.ts` under `SCOPE`. Adding a surface means
adding a glob, and that is deliberately a visible change rather than a config flag.

---

## 2. Write like this

**Be direct.** Say what happened, to what, with which numbers.

> Untch paid StableEmail 0.02 USDC on Base. The message was delivered.

not

> Untch seamlessly orchestrates payments across the agentic economy.

**Use plain words.** If a shorter word works, it is the right word. `use` over `utilise`, `pay` over
`facilitate payment`, `refused` over `was unable to be processed`.

**Show evidence.** A claim with a transaction hash behind it is worth ten without one. If there is no
evidence yet, say what is missing instead of writing around it.

**Keep paragraphs short.** Three or four sentences. A wall of text reads as though nobody expected it
to be read.

**Sentence case for headings.** `Untch Mail delivery proof`, not `Untch Mail Delivery Proof`.

**Use real values.** `1.81 USDC` beats `a small balance`. `2 of 8 tools` beats `several tools`.

**Label maturity honestly.** If a tool is BETA, the copy says BETA. Never imply LIVE by omission.

---

## 3. Banned patterns

The linter fails on each of these.

### Punctuation

| Banned | Use instead |
| --- | --- |
| Em dash (`—`) | A full stop. Or a comma. Or brackets. |
| Semicolon (`;`) in prose | Two sentences |

Both are banned for the same reason: they are the joints a language model reaches for to fuse two
half-thoughts into one long sentence, and the fused sentence is almost always worse than the two
sentences it replaced. In code, in quoted provider text, in URLs and in hashes they are untouched.

### Constructions

- `X is not Y. It is Z.` The negation-then-reveal. It sounds profound and carries no information.
- `This is not just …`
- `Not another …`
- `More than a …`
- `At its core …`
- `In today's rapidly evolving …`

### Words

`Revolutionary`, `Game-changing`, `Seamless`, `Unlock`, `Empower`, `The future of`,
`We are thrilled`, `We are excited to announce`.

### Claims

- Manifesto lines with no product behind them. If a sentence would survive being moved to a different
  company's homepage unchanged, it is not saying anything about Untch.
- Calling something **agentic** without naming the action. `an agentic payment layer` says nothing.
  `an agent proposes a purchase and Untch decides whether to fund it` says the same thing and is
  true. The linter requires a concrete verb near the word.

---

## 4. Allowlisting

Some legitimate copy will trip a rule. Quoting a provider's own marketing, or reproducing an error
string verbatim, are the common cases.

Add a disable comment on the line before, **with a reason**:

```md
<!-- copy-lint-disable-next-line quoting StableEmail's own endpoint description -->
```

```tsx
{/* copy-lint-disable-next-line reproducing the provider's error text exactly */}
```

The reason is required and the linter rejects an empty one. There is deliberately no file-level or
directory-level disable: a check that can be switched off wholesale for a surface is a check that
will be, on the day somebody is in a hurry, for the surface that matters most.

---

## 5. Running it

```
pnpm lint:public-copy          # fails on any violation
pnpm lint:public-copy --list   # show what is in scope and exit
```

CI runs the first form. Tests for the linter itself are in `scripts/test/lint-public-copy.test.ts`,
and they cover both directions: that it catches an em dash, a semicolon, a negation-then-reveal, a
`not another`, and launch filler, and that it leaves transaction hashes, error codes, quoted provider
text, URLs and ordinary technical prose alone.

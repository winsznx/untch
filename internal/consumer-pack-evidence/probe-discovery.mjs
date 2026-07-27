// Provider protocol probe: capture real 402 / MPP challenges and decode them.
const TARGETS = [
  ["purch", "GET", "https://api.purch.xyz/x402/search?q=wireless+headphones"],
  ["purch", "GET", "https://api.purch.xyz/x402/shop?q=coffee+mug"],
  ["purch", "POST", "https://api.purch.xyz/x402/buy", { query: "coffee mug", shipping: {} }],
  ["purch", "GET", "https://api.purch.xyz/x402/vault/search?q=skill"],
  ["purch", "GET", "https://api.purch.xyz/"],
  ["purch", "GET", "https://api.purch.xyz/x402/openapi.json"],
  ["purch", "GET", "https://purch.xyz/skills.md"],

  ["stabledomains", "GET", "https://stabledomains.dev/skills.md"],
  ["stabledomains", "GET", "https://stabledomains.dev/openapi.json"],
  ["stabledomains", "GET", "https://stabledomains.dev/api/domains/check?domain=untchtest123.xyz"],
  ["stabledomains", "GET", "https://stabledomains.dev/api/check?domain=untchtest123.xyz"],
  ["stabledomains", "GET", "https://stabledomains.dev/.well-known/x402"],

  ["stablemerch", "GET", "https://stablemerch.dev/skills.md"],
  ["stablemerch", "GET", "https://stablemerch.dev/openapi.json"],
  ["stablemerch", "GET", "https://stablemerch.dev/.well-known/x402"],

  ["stableemail", "GET", "https://stableemail.dev/skills.md"],
  ["stableemail", "GET", "https://stableemail.dev/openapi.json"],
  ["stableemail", "GET", "https://stableemail.dev/.well-known/x402"],

  ["stabletravel", "GET", "https://stabletravel.dev/skills.md"],
  ["stabletravel", "GET", "https://stabletravel.dev/openapi.json"],
  ["stabletravel", "GET", "https://stabletravel.dev/.well-known/x402"],

  ["stableenrich", "GET", "https://stableenrich.dev/openapi.json"],
];

function decodeHeader(v) {
  if (!v) return null;
  try { return JSON.parse(Buffer.from(v, "base64").toString("utf8")); }
  catch { try { return JSON.parse(v); } catch { return { raw: v.slice(0, 200) }; } }
}

const out = [];
for (const [provider, method, url, body] of TARGETS) {
  const rec = { provider, method, url };
  try {
    const ctl = AbortSignal.timeout(20000);
    const res = await fetch(url, {
      method,
      signal: ctl,
      ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
    });
    rec.status = res.status;
    rec.contentType = res.headers.get("content-type");
    const pr = res.headers.get("payment-required") || res.headers.get("PAYMENT-REQUIRED");
    const wa = res.headers.get("www-authenticate");
    if (pr) rec.paymentRequired = decodeHeader(pr);
    if (wa) rec.wwwAuthenticate = wa;
    const text = await res.text();
    rec.bodyLen = text.length;
    if (text.trim().startsWith("{") || text.trim().startsWith("[")) {
      try { rec.body = JSON.parse(text); } catch { rec.bodySnippet = text.slice(0, 1500); }
    } else {
      rec.bodySnippet = text.slice(0, 2500);
    }
  } catch (e) {
    rec.error = String(e && e.message ? e.message : e);
  }
  out.push(rec);
  process.stderr.write(`${provider} ${method} ${url} -> ${rec.status ?? rec.error}\n`);
}
console.log(JSON.stringify(out, null, 2));

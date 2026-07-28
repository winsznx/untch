// Capture the exact 402 challenge from each provider's PAID endpoints.
const T = [
  ["stabledomains", "POST", "https://stabledomains.dev/api/check", { domain: "untchprobe123.xyz" }],
  ["stabledomains", "POST", "https://stabledomains.dev/api/search", { name: "untchprobe123" }],
  ["stabledomains", "POST", "https://stabledomains.dev/api/register", { domain: "untchprobe123.xyz" }],
  ["stabledomains", "POST", "https://stabledomains.dev/api/domain/renew", { domain: "untchprobe123.xyz" }],
  ["stabledomains", "POST", "https://stabledomains.dev/api/domain/status", { domain: "untchprobe123.xyz" }],
  ["stabledomains", "POST", "https://stabledomains.dev/api/domain/dns", { domain: "untchprobe123.xyz" }],

  ["stableemail", "POST", "https://stableemail.dev/api/send", { to: ["probe@example.com"], subject: "probe", text: "probe" }],

  ["stablemerch", "GET", "https://stablemerch.dev/api/catalog", null],
  ["stablemerch", "POST", "https://stablemerch.dev/api/drafts", { client_request_id: "probe-1", product_slug: "mug", image_url: "https://example.com/x.png" }],

  ["stabletravel", "POST", "https://stabletravel.dev/api/flights/search", { origin: "SFO", destination: "JFK", departureDate: "2026-09-01", adults: 1 }],
  ["stabletravel", "POST", "https://stabletravel.dev/api/hotels/search", { cityCode: "PAR", checkInDate: "2026-09-01", checkOutDate: "2026-09-03", adults: 1 }],
  ["stabletravel", "GET", "https://stabletravel.dev/api/health", null],

  ["purch", "GET", "https://api.purch.xyz/x402/vault/buy?id=1", null],
  ["purch", "GET", "https://api.purch.xyz/x402/vault/download?id=1", null],
];

function dec(v) {
  if (!v) return null;
  try { return JSON.parse(Buffer.from(v, "base64").toString("utf8")); }
  catch { try { return JSON.parse(v); } catch { return { raw: v.slice(0, 300) }; } }
}

const out = [];
for (const [provider, method, url, body] of T) {
  const rec = { provider, method, url };
  try {
    const res = await fetch(url, {
      method, signal: AbortSignal.timeout(25000),
      ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
    });
    rec.status = res.status;
    const hdrs = {};
    res.headers.forEach((v, k) => { if (/payment|authenticate|x-mpp|mpp/i.test(k)) hdrs[k] = v; });
    rec.paymentHeaders = hdrs;
    const pr = res.headers.get("payment-required");
    if (pr) rec.challenge = dec(pr);
    const t = await res.text();
    try { rec.body = JSON.parse(t); } catch { rec.bodySnippet = t.slice(0, 1200); }
  } catch (e) { rec.error = String(e?.message ?? e); }
  out.push(rec);
  process.stderr.write(`${provider} ${method} ${url} -> ${rec.status ?? rec.error}\n`);
}
console.log(JSON.stringify(out, null, 2));

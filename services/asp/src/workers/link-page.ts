/**
 * The signing page this service has been advertising since before it existed.
 *
 * THE BUG
 *
 * `link/start` returns `walletActionUrl: {base}/link/{linkRequestId}` and instructions whose first
 * step is "Open {that URL} with the wallet you want this account to be." That route was never served
 * — not by the Worker, not by Express, and there is no such page in `apps/web`. So the first
 * instruction given to anyone setting up an account pointed at a 404, and every account-scoped
 * feature behind it (policy registration, default policy, preflight against your own rules) was
 * unreachable for anyone who did not drive the raw API themselves.
 *
 * WHY THE PAGE CANNOT JUST BUILD THE MESSAGE
 *
 * `buildLinkMessage` composes the exact wording, Resources lines and stamps the server will verify.
 * A browser reproducing that would be a second implementation that can drift, and drift here appears
 * as an unexplained signature rejection. So the page ASKS for the message
 * (`POST /consumer/account/link/{id}/message`) once the wallet has revealed which address is signing.
 *
 * WHY THE ONE-TIME CODE TRAVELS IN THE URL FRAGMENT
 *
 * Completing a link needs the code, which is returned exactly once by `link/start` and stored hashed
 * — the page cannot look it up, by design. A fragment is the one part of a URL browsers never send
 * to a server: it stays out of our access logs, out of `Referer`, and out of anything downstream.
 * The alternative was asking a human to copy a code between two windows, which is the step people
 * get wrong.
 *
 * The page is one self-contained document with no external requests, because a wallet-signing page
 * that pulls a script from a CDN is a wallet-signing page whose behaviour someone else controls.
 */

import type { Route } from "./router";

export const LINK_PAGE_ROUTE = "/link/:linkRequestId" as const;

const escapeHtml = (raw: string): string =>
  raw.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(linkRequestId: string): string {
  const id = escapeHtml(linkRequestId);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Link your wallet — Untch</title>
<style>
  :root { color-scheme: light dark; --bg:#fbfbfa; --fg:#1a1a19; --muted:#6b6b68; --line:#e4e4e1; --accent:#1a1a19; --bad:#b4342a; --good:#1f7a4d; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#141413; --fg:#f0efec; --muted:#9a9a95; --line:#2c2c2a; --accent:#f0efec; --bad:#e07a70; --good:#5fbf8f; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
  main { max-width: 34rem; margin: 0 auto; padding: 3rem 1.25rem 4rem; }
  h1 { font-size: 1.5rem; font-weight: 600; margin: 0 0 .35rem; letter-spacing: -.01em; }
  p  { margin: 0 0 1rem; color: var(--muted); }
  button { font: inherit; font-weight: 500; padding: .7rem 1.1rem; border-radius: .5rem; border: 1px solid var(--accent);
           background: var(--accent); color: var(--bg); cursor: pointer; }
  button[disabled] { opacity: .45; cursor: not-allowed; }
  pre { white-space: pre-wrap; word-break: break-word; background: transparent; border: 1px solid var(--line);
        border-radius: .5rem; padding: .85rem; font: 13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; margin: 0 0 1rem; }
  .note { font-size: .875rem; }
  .bad { color: var(--bad); }
  .good { color: var(--good); }
  .hide { display: none; }
  dl { display: grid; grid-template-columns: auto 1fr; gap: .3rem .8rem; font-size: .875rem; margin: 0 0 1.25rem; }
  dt { color: var(--muted); }
  dd { margin: 0; font-family: ui-monospace,SFMono-Regular,Menlo,monospace; word-break: break-all; }
</style>
</head>
<body>
<main>
  <h1>Link your wallet</h1>
  <p>This proves which wallet you are. <strong>It approves no payment</strong> — nothing reachable from
  this page can move funds.</p>

  <div id="need-code" class="hide">
    <p class="bad">This link is missing its one-time code.</p>
    <p class="note">Open the full <code>walletActionUrl</code> that <code>/consumer/account/link/start</code>
    returned — the part after <code>#</code> is the code, and it is what lets this page finish the link
    for you. It is never sent to our servers.</p>
  </div>

  <div id="flow">
    <dl>
      <dt>Request</dt><dd>${id}</dd>
      <dt id="addr-label" class="hide">Wallet</dt><dd id="addr" class="hide"></dd>
    </dl>
    <pre id="message" class="hide"></pre>
    <p id="status" class="note"></p>
    <button id="go">Connect wallet</button>
  </div>
</main>
<script>
(function () {
  var id = ${JSON.stringify(linkRequestId)};
  // Never sent to the server: browsers do not transmit the fragment, so it stays out of logs and Referer.
  var code = decodeURIComponent((location.hash || "").replace(/^#/, "").replace(/^code=/, ""));
  var go = document.getElementById("go");
  var statusEl = document.getElementById("status");
  var msgEl = document.getElementById("message");
  var addrEl = document.getElementById("addr");
  var addrLabel = document.getElementById("addr-label");

  if (!code) {
    document.getElementById("need-code").classList.remove("hide");
    document.getElementById("flow").classList.add("hide");
    return;
  }

  function say(text, cls) { statusEl.textContent = text; statusEl.className = "note " + (cls || ""); }

  async function post(path, body) {
    var res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(data.message || ("request failed with " + res.status));
    return data;
  }

  go.addEventListener("click", async function () {
    var eth = window.okxwallet || window.ethereum;
    if (!eth) { say("No wallet found in this browser. Open this page in your wallet's browser, or use the API steps.", "bad"); return; }

    go.disabled = true;
    try {
      say("Waiting for the wallet to share an address…");
      var accounts = await eth.request({ method: "eth_requestAccounts" });
      var address = accounts && accounts[0];
      if (!address) throw new Error("the wallet returned no address");

      var chainId = 196;
      try { chainId = parseInt(await eth.request({ method: "eth_chainId" }), 16) || 196; } catch (e) {}

      addrEl.textContent = address;
      addrEl.classList.remove("hide");
      addrLabel.classList.remove("hide");

      // The SERVER authors the message. A copy built here could drift from the one it verifies.
      say("Asking the server for the exact message to sign…");
      var built = await post("/consumer/account/link/" + encodeURIComponent(id) + "/message", {
        address: address, chainId: chainId,
      });

      msgEl.textContent = built.siweMessage;
      msgEl.classList.remove("hide");
      say("Sign the message above in your wallet.");

      var signature = await eth.request({
        method: "personal_sign",
        params: [built.siweMessage, built.address],
      });

      say("Verifying the signature…");
      var done = await post("/consumer/account/link/complete", {
        linkRequestId: id, code: code, message: built.siweMessage, signature: signature,
      });

      go.classList.add("hide");
      var next = done.nextAction && done.nextAction.message ? " " + done.nextAction.message : "";
      say("Linked. Account " + done.accountId + "." + next, "good");

      // Only after the link actually succeeded, and only to an origin the server allow-listed.
      if (done.returnUrl) { setTimeout(function () { location.href = done.returnUrl; }, 1500); }
    } catch (err) {
      // A rejected signature is a decision, not a fault — say so without alarming language.
      var m = (err && err.message) || String(err);
      say(/user rejected|denied/i.test(m) ? "You declined the signature. Nothing was linked." : m, "bad");
      go.disabled = false;
    }
  });
})();
</script>
</body>
</html>`;
}

export function linkPageRoute(): Route {
  return {
    method: "GET",
    pattern: LINK_PAGE_ROUTE,
    bodyMode: "none",
    handler: async (req) =>
      new Response(page(req.params.linkRequestId ?? ""), {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          /**
           * No external origin can supply code to a page that signs things, and nothing may frame it.
           * `'unsafe-inline'` covers this document's own inline script and styles, which are the only
           * ones it has — there is no external fetch to allow.
           */
          "content-security-policy":
            "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
            "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
          "referrer-policy": "no-referrer",
          "x-frame-options": "DENY",
          "cache-control": "no-store",
        },
      }),
  };
}

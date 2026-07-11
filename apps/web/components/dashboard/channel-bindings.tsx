"use client";

import { useCallback, useEffect, useState } from "react";
import { useWallet } from "../wallet/wallet-context";

/**
 * The self-serve channel-binding UI (§27 / §15). Once signed in, the operator links their own Telegram,
 * Discord, or Slack handle through a real code roundtrip, replacing the env-var single-operator interim.
 * Request a code, send it from the handle to the Untch bot (which the running channel receiver confirms),
 * then the binding is verified and persisted per operator.
 */

const CHANNELS = ["telegram", "discord", "slack"] as const;
type Channel = (typeof CHANNELS)[number];

interface BindingView {
  channel: Channel;
  handle: string;
  status: "pending" | "verified";
  since: string;
}

interface Started {
  code: string;
  expiresAt: string;
  channel: Channel;
  handle: string;
}

export function ChannelBindings() {
  const w = useWallet();
  const authed = w.status === "authenticated";
  const [bindings, setBindings] = useState<BindingView[]>([]);
  const [channel, setChannel] = useState<Channel>("telegram");
  const [handle, setHandle] = useState("");
  const [started, setStarted] = useState<Started | null>(null);
  const [code, setCode] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!authed) return;
    try {
      const res = await fetch("/api/bindings");
      if (!res.ok) return;
      const json = (await res.json()) as { bindings: BindingView[] };
      setBindings(json.bindings);
    } catch {
      /* not signed in */
    }
  }, [authed]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function requestCode() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/bindings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel, handle }),
      });
      const json = (await res.json()) as Started & { error?: string };
      if (!res.ok) throw new Error(json.error ?? "failed");
      setStarted(json);
      await refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!started) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/bindings/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel: started.channel, code }),
      });
      const json = (await res.json()) as { ok: boolean; reason?: string };
      if (!json.ok) throw new Error(json.reason ?? "confirm failed");
      setStarted(null);
      setCode("");
      setHandle("");
      setMsg(`${started.channel} verified.`);
      await refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  }

  async function remove(ch: Channel) {
    setBusy(true);
    try {
      await fetch("/api/bindings/remove", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel: ch }),
      });
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  if (!authed) {
    return (
      <span className="text-body-sm" style={{ color: "var(--color-inverse-muted)" }}>
        Sign in above to link your control channels.
      </span>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <span className="text-title-sm" style={{ color: "var(--color-text)" }}>Your channels</span>
        {bindings.length === 0 ? (
          <span className="text-body-sm" style={{ color: "var(--color-inverse-muted)" }}>No channels linked yet.</span>
        ) : (
          bindings.map((b) => (
            <div key={b.channel} className="flex flex-wrap items-center justify-between gap-3">
              <span className="text-body-sm" style={{ color: "var(--color-text)" }}>
                {b.channel} · <span style={{ fontFamily: "ui-monospace, monospace" }}>{b.handle}</span>
              </span>
              <div className="flex items-center gap-3">
                <span className="rounded-tags px-3 py-1 text-caption-lg" style={{ border: `1px solid ${b.status === "verified" ? "var(--color-positive)" : "var(--color-signal)"}`, color: b.status === "verified" ? "var(--color-positive)" : "var(--color-signal)" }}>
                  {b.status}
                </span>
                <button type="button" onClick={() => void remove(b.channel)} disabled={busy} className="text-caption-lg underline-offset-4 hover:underline" style={{ color: "var(--color-inverse-muted)" }}>
                  remove
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="flex flex-col gap-4" style={{ borderTop: "1px solid var(--color-border-soft)", paddingTop: 20 }}>
        <span className="text-title-sm" style={{ color: "var(--color-text)" }}>Link a channel</span>

        {!started ? (
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-caption uppercase" style={{ color: "var(--color-inverse-muted)", letterSpacing: "0.24px" }}>Channel</span>
              <select value={channel} onChange={(e) => setChannel(e.target.value as Channel)} className="rounded-inputs px-3 py-2 text-body-sm" style={fieldStyle}>
                {CHANNELS.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-caption uppercase" style={{ color: "var(--color-inverse-muted)", letterSpacing: "0.24px" }}>Handle / chat id</span>
              <input value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="e.g. 123456789" className="w-56 rounded-inputs px-3 py-2 text-body-sm" style={{ ...fieldStyle, fontFamily: "ui-monospace, monospace" }} />
            </label>
            <button type="button" onClick={() => void requestCode()} disabled={busy || !handle.trim()} style={primaryBtn(busy || !handle.trim())}>
              Request code
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-3 rounded-inputs p-4" style={{ background: "var(--color-canvas)", border: "1px solid var(--color-border-soft)" }}>
            <span className="text-body-sm" style={{ color: "var(--color-inverse-canvas)" }}>
              Send this code from your <strong style={{ color: "var(--color-text)" }}>{started.channel}</strong> handle{" "}
              <span style={{ fontFamily: "ui-monospace, monospace" }}>{started.handle}</span> to the Untch bot. The bot
              confirms it automatically; in this dashboard build, enter the code below to complete the roundtrip.
            </span>
            <span className="text-heading-lg" style={{ color: "var(--color-data)", fontFamily: "ui-monospace, monospace", letterSpacing: "2px" }}>
              {started.code}
            </span>
            <div className="flex flex-wrap items-end gap-3">
              <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="paste the code" className="w-56 rounded-inputs px-3 py-2 text-body-sm" style={{ ...fieldStyle, fontFamily: "ui-monospace, monospace" }} />
              <button type="button" onClick={() => void confirm()} disabled={busy || !code.trim()} style={primaryBtn(busy || !code.trim())}>Confirm</button>
              <button type="button" onClick={() => { setStarted(null); setCode(""); }} disabled={busy} style={ghostBtn}>Cancel</button>
            </div>
          </div>
        )}

        {msg ? <span className="text-caption-lg" style={{ color: "var(--color-signal)" }}>{msg}</span> : null}
      </div>
    </div>
  );
}

const fieldStyle = { background: "var(--color-canvas)", border: "1px solid var(--color-border-soft)", color: "var(--color-text)" } as const;
function primaryBtn(disabled: boolean) {
  return { borderRadius: "9999px", padding: "10px 20px", fontSize: 14, fontWeight: 500, background: "var(--color-action)", color: "var(--color-text)", border: "1px solid var(--color-action)", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.55 : 1 };
}
const ghostBtn = { borderRadius: "9999px", padding: "10px 20px", fontSize: 14, fontWeight: 500, background: "transparent", color: "var(--color-text)", border: "1px solid var(--color-border)", cursor: "pointer" };

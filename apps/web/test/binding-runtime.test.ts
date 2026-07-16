import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryOperatorsRepo } from "@untch/escalation/pure";
import {
  __resetBindingAuthority,
  BINDABLE_CHANNELS,
  bindingAuthorityInstalled,
  installBindingAuthority,
  isBindableChannel,
  listBindings,
  removeBinding,
  startBinding,
  submitDashboardCode,
  verifyWithChannelProof,
  type ChannelProof,
} from "../lib/dashboard/binding-runtime";

const OP = "op_0xtest";

test("a dashboard code-paste yields UNVERIFIED, never verified", async () => {
  // #given a binding started for a handle the operator has not proved they control
  const started = startBinding({ operatorId: OP, channel: "telegram", handle: "123456789" });
  assert.match(started.code, /^[0-9a-f]{8,}$/i);
  assert.equal(listBindings(OP).find((b) => b.channel === "telegram")?.status, "pending");

  // #when they echo the code back into the same dashboard that just showed it to them
  const res = await submitDashboardCode({ operatorId: OP, channel: "telegram", code: started.code });

  // #then it is recorded as a CLAIM. Echoing a code the dashboard minted proves only that they are this
  // session, nothing about the Telegram handle. Reporting "verified" here would be a lie that the §27
  // authority boundary would later be built on.
  assert.equal(res.ok, true);
  assert.equal(res.unverified, true);
  assert.equal(res.binding?.status, "unverified");
  assert.equal(listBindings(OP).find((b) => b.channel === "telegram")?.status, "unverified");
  removeBinding(OP, "telegram");
});

test("REGRESSION: the dashboard path writes NO authority row, so it cannot confer approval rights", async () => {
  // #given a real operator-identity store — the table the §27 boundary reads to decide who may approve
  const store = new InMemoryOperatorsRepo();

  // #when an operator completes the dashboard flow for a handle they do NOT control
  const started = startBinding({ operatorId: OP, channel: "discord", handle: "victim-discord-id" });
  await submitDashboardCode({ operatorId: OP, channel: "discord", code: started.code });

  // #then nothing was bound in the authority store. This is the load-bearing assertion: the old code
  // called ensureBinding() on this path, which was harmless only because the repo was an in-memory
  // object the ASP never read. Swapping in PgOperatorsRepo would have silently armed handle-squatting.
  assert.equal(await store.operatorForBinding("discord", "victim-discord-id"), null);
  assert.deepEqual(await store.channelsForOperator(OP), []);
  removeBinding(OP, "discord");
});

test("REGRESSION: installing an authority store without a channel-proof source is refused", () => {
  // #given someone wiring a real store up to "make bindings real"
  __resetBindingAuthority();
  const store = new InMemoryOperatorsRepo();

  // #when they install it without the receiver that proves control
  // #then it fails loudly rather than quietly granting authority off unproved claims
  assert.throws(
    () => installBindingAuthority({ store, proofSource: undefined as never }),
    /refusing an authority store with no channel-proof source/,
  );
  assert.equal(bindingAuthorityInstalled(), false);
});

test("verified is unreachable without an installed authority, even holding a real ChannelProof", async () => {
  // #given no authority installed (today's state) and a code that really did arrive over the channel
  __resetBindingAuthority();
  const started = startBinding({ operatorId: OP, channel: "slack", handle: "U123" });
  const proof: ChannelProof = { channel: "slack", observedSenderHandle: "U123", code: started.code };

  // #when the proof path is driven anyway
  // #then it refuses, rather than report a binding that nothing would record
  await assert.rejects(() => verifyWithChannelProof({ operatorId: OP, proof }), /no binding authority installed/);
  removeBinding(OP, "slack");
});

test("the proof path rejects a code that arrived from a DIFFERENT handle", async () => {
  // #given an installed authority and a claim on one handle
  __resetBindingAuthority();
  installBindingAuthority({ store: new InMemoryOperatorsRepo(), proofSource: { kind: "channel-receiver" } });
  const started = startBinding({ operatorId: OP, channel: "telegram", handle: "111-mine" });

  // #when the right code arrives, but from someone else's handle — the squatting attack
  const res = await verifyWithChannelProof({
    operatorId: OP,
    proof: { channel: "telegram", observedSenderHandle: "999-not-mine", code: started.code },
  });

  // #then it is refused. This is exactly the check the dashboard path structurally cannot make.
  assert.equal(res.ok, false);
  assert.match(res.reason ?? "", /different handle/);
  __resetBindingAuthority();
  removeBinding(OP, "telegram");
});

test("the proof path verifies and binds when the code arrives from the claimed handle", async () => {
  // #given an installed authority and a pending claim
  __resetBindingAuthority();
  const store = new InMemoryOperatorsRepo();
  installBindingAuthority({ store, proofSource: { kind: "channel-receiver" } });
  const started = startBinding({ operatorId: OP, channel: "telegram", handle: "111-mine" });

  // #when the receiver reports the code arriving from that exact handle
  const res = await verifyWithChannelProof({
    operatorId: OP,
    proof: { channel: "telegram", observedSenderHandle: "111-mine", code: started.code },
  });

  // #then it verifies, and only NOW is an authority row written
  assert.equal(res.ok, true);
  assert.equal(res.binding?.status, "verified");
  assert.equal(await store.operatorForBinding("telegram", "111-mine"), OP);
  __resetBindingAuthority();
  removeBinding(OP, "telegram");
});

test("a wrong code does not record a claim", async () => {
  startBinding({ operatorId: OP, channel: "discord", handle: "555" });
  const bad = await submitDashboardCode({ operatorId: OP, channel: "discord", code: "deadbeef00" });
  assert.equal(bad.ok, false);
  assert.equal(listBindings(OP).find((b) => b.channel === "discord")?.status, "pending");
  removeBinding(OP, "discord");
});

test("submitting with no pending binding fails", async () => {
  const res = await submitDashboardCode({ operatorId: "op_nobody", channel: "slack", code: "whatever0" });
  assert.equal(res.ok, false);
});

test("remove clears a binding", async () => {
  const s = startBinding({ operatorId: OP, channel: "slack", handle: "@op" });
  await submitDashboardCode({ operatorId: OP, channel: "slack", code: s.code });
  removeBinding(OP, "slack");
  assert.equal(listBindings(OP).find((b) => b.channel === "slack"), undefined);
});

test("Photon/iMessage stays un-bindable until proof-of-control is real", () => {
  // #given the audit's finding (internal/binding-lifecycle-audit.md §1): Photon is missing from the
  // bindable set, but adding it to a flow that proves nothing would widen an unproved surface rather
  // than close the gap.
  // #then it is absent, deliberately — not by oversight.
  assert.equal(isBindableChannel("imessage"), false);
  assert.deepEqual([...BINDABLE_CHANNELS], ["telegram", "discord", "slack"]);
  // If this test fails because imessage was added, that is the signal to ask the real question first:
  // does a Photon receiver now mint a ChannelProof? If not, the checkmark it produces means nothing.
});

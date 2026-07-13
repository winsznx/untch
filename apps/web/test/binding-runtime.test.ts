import assert from "node:assert/strict";
import { test } from "node:test";
import { confirmBinding, listBindings, removeBinding, startBinding } from "../lib/dashboard/binding-runtime";

const OP = "op_0xtest";

test("the code roundtrip verifies a binding for the right operator", async () => {
  const started = startBinding({ operatorId: OP, channel: "telegram", handle: "123456789" });
  assert.match(started.code, /^[0-9a-f]{8,}$/i);

  const pending = listBindings(OP).find((b) => b.channel === "telegram");
  assert.equal(pending?.status, "pending");

  const ok = await confirmBinding({ operatorId: OP, channel: "telegram", code: started.code });
  assert.equal(ok.ok, true);
  assert.equal(ok.binding?.status, "verified");

  const verified = listBindings(OP).find((b) => b.channel === "telegram");
  assert.equal(verified?.status, "verified");
  assert.equal(verified?.handle, "123456789");
});

test("a wrong code does not verify", async () => {
  startBinding({ operatorId: OP, channel: "discord", handle: "555" });
  const bad = await confirmBinding({ operatorId: OP, channel: "discord", code: "deadbeef00" });
  assert.equal(bad.ok, false);
  assert.equal(listBindings(OP).find((b) => b.channel === "discord")?.status, "pending");
});

test("confirming with no pending binding fails", async () => {
  const res = await confirmBinding({ operatorId: "op_nobody", channel: "slack", code: "whatever0" });
  assert.equal(res.ok, false);
});

test("remove clears a binding", async () => {
  const s = startBinding({ operatorId: OP, channel: "slack", handle: "@op" });
  await confirmBinding({ operatorId: OP, channel: "slack", code: s.code });
  removeBinding(OP, "slack");
  assert.equal(listBindings(OP).find((b) => b.channel === "slack"), undefined);
});

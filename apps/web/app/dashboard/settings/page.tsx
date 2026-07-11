import { DashCard, SectionTitle } from "../../../components/dashboard/ui";
import { ChannelBindings } from "../../../components/dashboard/channel-bindings";

export default function Settings() {
  return (
    <div className="flex flex-col gap-8">
      <SectionTitle kicker="Settings" title="Control channels" />

      <p className="max-w-2xl text-body" style={{ color: "var(--color-inverse-canvas)" }}>
        Link the channels you want to approve escalations from. Each binding is a code roundtrip: request a
        code, send it from your handle to the Untch bot, and the binding is verified and stored against your
        operator identity. This replaces the single-operator environment configuration, so a second approver
        later is a new binding, not a redeploy.
      </p>

      <DashCard>
        <ChannelBindings />
      </DashCard>
    </div>
  );
}

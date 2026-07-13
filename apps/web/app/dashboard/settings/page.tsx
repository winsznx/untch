import { DashCard, SectionTitle } from "../../../components/dashboard/ui";
import { ChannelBindings } from "../../../components/dashboard/channel-bindings";

export default function Settings() {
  return (
    <div className="flex flex-col gap-8">
      <SectionTitle
        kicker="Settings"
        title="Control channels"
        subtitle="Bind the channels you approve escalations from. Each is a code roundtrip verified against your operator identity — a second approver is a new binding, not a redeploy."
      />

      <DashCard>
        <ChannelBindings />
      </DashCard>
    </div>
  );
}

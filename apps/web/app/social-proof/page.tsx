import type { Metadata } from "next";
import { SiteHeader } from "../../components/site-header";
import { SocialProof } from "../../components/social-proof";

export const metadata: Metadata = {
  title: "Untch social proof — review",
  description: "Visual review page for the Untch social-proof section.",
};

export default function SocialProofReview() {
  return (
    <>
      <SiteHeader />
      <SocialProof />
    </>
  );
}

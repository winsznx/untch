import type { Metadata } from "next";
import { SiteHeader } from "../components/site-header";
import { Hero } from "../components/hero";
import { Problem } from "../components/landing/problem";
import { OperatorStory } from "../components/landing/operator-story";
import { HowItWorks } from "../components/landing/how-it-works";
import { Modes } from "../components/landing/modes";
import { LiveProof } from "../components/landing/live-proof";
import { SocialProof } from "../components/social-proof";
import { CtaBand } from "../components/cta-band";
import { SiteFooter } from "../components/site-footer";

export const metadata: Metadata = {
  title: "Untch: the model never touches the money",
  description: "Accounts payable for autonomous agents. Untch checks every payment before it moves and anchors every decision on X Layer.",
};

/**
 * Homepage band order: hero → problem → operator story → loop → modes (scroll scrub) →
 * live proof → on-chain verify → light CTA → footer.
 */
export default function Home() {
  return (
    <>
      <SiteHeader />
      <Hero />
      <Problem />
      <OperatorStory />
      <HowItWorks />
      <Modes />
      <LiveProof />
      <SocialProof />
      <CtaBand />
      <SiteFooter />
    </>
  );
}

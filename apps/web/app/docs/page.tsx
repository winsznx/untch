import { redirect } from "next/navigation";

/**
 * Canonical docs live on Mintlify at docs.untch.xyz.
 * This route exists so old /docs links and CTAs resolve cleanly once DNS is pointed.
 */
export default function DocsRedirect() {
  redirect("https://docs.untch.xyz");
}

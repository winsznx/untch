import type { Metadata } from "next";
import { Manrope, Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";

const manrope = Manrope({
  subsets: ["latin"],
  weight: ["500", "600"],
  variable: "--font-manrope",
  display: "swap",
});

const plusJakartaSans = Plus_Jakarta_Sans({
  subsets: ["latin"],
  weight: ["500", "600"],
  variable: "--font-plus-jakarta",
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://untch.xyz"),
  title: {
    default: "Untch — Spend governance for autonomous AI agents",
    template: "%s · Untch",
  },
  description:
    "The model never touches the money. Untch is the policy, escalation, and receipt layer that governs what your AI agents are allowed to spend.",
  applicationName: "Untch",
  // App icons: app/icon.png (512), app/apple-icon.png (180), app/favicon.ico — from internal/brand.
  icons: {
    icon: [
      { url: "/favicon-16.png", sizes: "16x16", type: "image/png" },
      { url: "/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/brand/pwa-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/apple-icon.png", sizes: "180x180", type: "image/png" }],
  },
  openGraph: {
    type: "website",
    siteName: "Untch",
    url: "https://untch.xyz",
    title: "Untch — Spend governance for autonomous AI agents",
    description: "The model never touches the money. Policy, escalation, and receipts for agent spend.",
  },
  twitter: {
    card: "summary_large_image",
    title: "Untch — Spend governance for autonomous AI agents",
    description: "The model never touches the money. Policy, escalation, and receipts for agent spend.",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${manrope.variable} ${plusJakartaSans.variable}`}>
      <body>{children}</body>
    </html>
  );
}

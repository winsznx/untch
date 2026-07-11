/**
 * Hero line-art illustration.
 *
 * FAITHFUL TO SPEC: the *treatment* is Impilo's line-art — monochromatic Lilac Mist stroke
 * (`--color-illustration`), 1.5px, no fills, schematic not literal (design.md Imagery + §4c).
 *
 * NEW DECISION (confirm): the *subject matter*. §4c is explicit that Impilo's medical devices
 * do not map and must be swapped for vault / agent / chain motifs. This composition reads
 * top-to-bottom as the Untch loop: an agent node → a vault holding the funds → a chain of
 * anchored receipts. Two small Clinical Cyan dots mark anchored receipts (data points), the
 * one system color allowed to carry data meaning.
 */
export function HeroIllustration({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 320 560"
      fill="none"
      role="img"
      aria-label="Schematic of the Untch loop: an agent, a vault holding funds, and a chain of anchored receipts"
      className={className}
      style={{ width: "100%", height: "auto", maxHeight: "70vh" }}
    >
      <g
        stroke="var(--color-illustration)"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {/* Agent node — hexagon with an inner ring */}
        <path d="M160 24 L196 45 L196 87 L160 108 L124 87 L124 45 Z" />
        <circle cx="160" cy="66" r="15" />
        <circle cx="160" cy="66" r="4" fill="var(--color-illustration)" stroke="none" />

        {/* connector: agent → vault */}
        <path d="M160 108 L160 150" strokeDasharray="2 7" />

        {/* Vault — safe body, door ring, dial spokes, tick marks */}
        <rect x="70" y="150" width="180" height="176" rx="16" />
        <circle cx="160" cy="238" r="62" />
        <circle cx="160" cy="238" r="44" />
        <circle cx="160" cy="238" r="9" />
        <path d="M160 238 L160 200 M160 238 L192 258 M160 238 L128 258" />
        <path d="M160 176 L160 168 M222 238 L230 238 M160 300 L160 308 M98 238 L90 238" />
        {/* vault handle bar */}
        <path d="M250 216 L266 216 L266 260 L250 260" />

        {/* connector: vault → chain */}
        <path d="M160 326 L160 366" strokeDasharray="2 7" />

        {/* Chain of anchored receipts — three interlocked links descending */}
        <rect x="126" y="366" width="68" height="42" rx="21" />
        <rect x="126" y="430" width="68" height="42" rx="21" />
        <rect x="126" y="494" width="68" height="42" rx="21" />
        <path d="M160 408 L160 430 M160 472 L160 494" />

        {/* anchored-receipt data points (the one cyan data use) */}
        <circle cx="212" cy="387" r="4" fill="var(--color-data)" stroke="none" />
        <circle cx="108" cy="515" r="4" fill="var(--color-data)" stroke="none" />
        <path d="M212 387 L194 387 M108 515 L126 515" stroke="var(--color-data)" strokeDasharray="2 5" />
      </g>
    </svg>
  );
}

/**
 * The dashboard nav icon set — 20×20 stroke glyphs on `currentColor`, one per route. Kept as a single
 * switch so the whole set shares stroke weight/caps and reads as one family (the collapsed rail and the
 * mobile drawer both lean on these being instantly recognizable at a glance).
 */
export type NavIconName =
  | "consumer"
  | "start"
  | "overview"
  | "intents"
  | "policies"
  | "escalations"
  | "ledger"
  | "vault"
  | "vendors"
  | "reports"
  | "disputes"
  | "settings"
  | "explorer";

export function NavIcon({ name, className }: { name: NavIconName; className?: string }) {
  const svg = {
    width: 20,
    height: 20,
    viewBox: "0 0 20 20",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.6,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className,
    "aria-hidden": true,
  };
  switch (name) {
    case "start":
      return (
        <svg {...svg}>
          <path d="M10 2.5c3 1 5 3.5 5 7 0 1.4-.3 2.6-.8 3.6l-4.2 2-4.2-2C5.3 12.1 5 10.9 5 9.5c0-3.5 2-6 5-7Z" />
          <circle cx="10" cy="8.5" r="1.5" />
          <path d="M7.5 15c-1 .8-1.3 2-1.3 2.5.8 0 1.8-.4 2.5-1.2" />
        </svg>
      );
    case "overview":
      return (
        <svg {...svg}>
          <rect x="2.75" y="2.75" width="6" height="6" rx="1.5" />
          <rect x="11.25" y="2.75" width="6" height="6" rx="1.5" />
          <rect x="2.75" y="11.25" width="6" height="6" rx="1.5" />
          <rect x="11.25" y="11.25" width="6" height="6" rx="1.5" />
        </svg>
      );
    case "intents":
      return (
        <svg {...svg}>
          <path d="M2.5 11.5h3l2-6 3 10 2-7h4.5" />
        </svg>
      );
    case "policies":
      return (
        <svg {...svg}>
          <path d="M10 2.5 16.5 5v4.6c0 3.9-2.8 6.4-6.5 7.4-3.7-1-6.5-3.5-6.5-7.4V5Z" />
          <path d="M7.4 10l1.8 1.8 3.6-3.9" />
        </svg>
      );
    case "escalations":
      return (
        <svg {...svg}>
          <path d="M6 8a4 4 0 0 1 8 0c0 3 .9 4.2 1.6 5H4.4C5.1 12.2 6 11 6 8Z" />
          <path d="M8.4 16a1.7 1.7 0 0 0 3.2 0" />
        </svg>
      );
    case "ledger":
      return (
        <svg {...svg}>
          <rect x="4.25" y="2.5" width="11.5" height="15" rx="1.6" />
          <path d="M7 6.5h6M7 9.5h6M7 12.5h3.5" />
        </svg>
      );
    case "vault":
      return (
        <svg {...svg}>
          <rect x="3.75" y="8.75" width="12.5" height="8.25" rx="2" />
          <path d="M6.75 8.75V6.5a3.25 3.25 0 0 1 6.5 0v2.25" />
          <path d="M10 12.25v2.25" />
        </svg>
      );
    case "vendors":
      return (
        <svg {...svg}>
          <path d="M3.5 8 5 3.75h10L16.5 8" />
          <path d="M4.25 8v8.25h11.5V8" />
          <path d="M4 8.25c1.6 0 2.2-1.4 2.2-1.4S6.8 8.5 8.4 8.5s2.1-1.6 2.1-1.6.5 1.6 2.1 1.6 2-1.4 2-1.4.6 1.4 2.2 1.4" />
        </svg>
      );
    case "reports":
      return (
        <svg {...svg}>
          <path d="M3.75 3.5v13h13" />
          <path d="M7 14v-3.5M10.5 14V7M14 14v-2" />
        </svg>
      );
    case "disputes":
      return (
        <svg {...svg}>
          <path d="M5 3v14.5" />
          <path d="M5 3.75h9.5l-2 3 2 3H5" />
        </svg>
      );
    case "settings":
      return (
        <svg {...svg}>
          <circle cx="10" cy="10" r="2.9" />
          <path d="M10 2.6v2.3M10 15.1v2.3M2.6 10h2.3M15.1 10h2.3M4.75 4.75l1.6 1.6M13.65 13.65l1.6 1.6M15.25 4.75l-1.6 1.6M4.75 15.25l1.6-1.6" />
        </svg>
      );
    case "consumer":
      // A bounded parcel: the consumer action, kept inside an authority boundary.
      return (
        <svg {...svg}>
          <path d="M4 6.5h12l-1 9.5a1.5 1.5 0 0 1-1.5 1.3h-7A1.5 1.5 0 0 1 5 16L4 6.5Z" />
          <path d="M7.25 6.5V5a2.75 2.75 0 0 1 5.5 0v1.5" />
        </svg>
      );
    case "explorer":
      return (
        <svg {...svg}>
          <circle cx="10" cy="10" r="7.25" />
          <path d="M12.9 7.1l-1.6 4.2-4.2 1.6 1.6-4.2Z" />
        </svg>
      );
  }
}

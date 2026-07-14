import { Spectrum } from "@spectrum-ts/core";
import { imessage } from "@spectrum-ts/imessage";
import type { PhotonConfig } from "./config";
import type { SpectrumInbound, SpectrumPort } from "./photon";

/**
 * The REAL Spectrum Cloud adapter — the ONLY file in this package that imports `spectrum-ts`. It maps
 * Photon's SDK onto the narrow `SpectrumPort` the (SDK-free, fully unit-tested) `PhotonChannel` depends
 * on. Nothing here decides anything about the money; it is pure transport.
 *
 * Verified against `spectrum-ts@10.0.0` source (not the marketing docs, which show a different, wrong
 * `spectrum.send("+1…")` shape):
 *   • `Spectrum({ projectId, projectSecret, platforms: [imessage.config()] })` is ASYNC → a SpectrumInstance.
 *   • `imessage(app)` returns the iMessage PlatformInstance: `space.create(handle)`, `user(id)`, and a
 *     `messages` stream whose `sender` carries the iMessage `address`/`service` fields (the core
 *     `app.messages` stream types `sender` as the bare `User`, without `address`).
 *   • `space.create(handleString)` RESOLVES an existing 1:1 conversation or creates one — so reusing the
 *     resolved space across sends does NOT burn a "new conversation" against the per-line/day quota.
 *   • `app.send(space, text)` accepts a resolved Space (there is no raw-phone-string send overload).
 *   • Delivery/read receipts are dropped by the SDK before they reach us — a resolved `send` is
 *     ACCEPTANCE only (see PhotonChannel header); this adapter cannot surface a signal the SDK discards.
 *
 * ── The SDK-boundary facade ──────────────────────────────────────────────────────────────────────────
 * `spectrum-ts`'s exported generics do not satisfy this repo's `exactOptionalPropertyTypes: true`, and its
 * `Platform` value is an overloaded callable whose `ReturnType` resolves to the wrong overload. Rather than
 * scatter casts through the logic, the SDK is bridged ONCE here through minimal hand-typed facades that
 * describe EXACTLY the surface Untch calls — which doubles as an explicit, auditable record of our
 * dependency on a Draft-status, fast-moving SDK. Every line of adapter logic below is fully type-checked
 * against these local facades; the only assertions are the two `as unknown as` boundary bridges.
 */

interface SpectrumSpace {
  readonly __platform?: string;
}

interface SpectrumSentMessage {
  readonly id?: string;
}

interface SpectrumApp {
  send(space: SpectrumSpace, content: string): Promise<SpectrumSentMessage | undefined>;
  stop(): Promise<void>;
}

interface IMessageSender {
  readonly address?: string;
  readonly service?: string;
}

interface IMessageInboundMessage {
  readonly direction: "inbound" | "outbound";
  readonly id: string;
  readonly content: unknown;
  readonly sender?: IMessageSender;
}

interface IMessagePlatform {
  readonly space: { create(handle: string): Promise<SpectrumSpace> };
  readonly messages: AsyncIterable<readonly [SpectrumSpace, IMessageInboundMessage]>;
}

/** The `Spectrum` factory, narrowed to the option/return surface this adapter uses. */
type SpectrumFactory = (opts: {
  projectId: string;
  projectSecret: string;
  platforms: unknown[];
}) => Promise<SpectrumApp>;

/** The `imessage` platform value: callable (bind an app → platform instance) AND carries `.config()`. */
type ImessagePlatformValue = ((app: SpectrumApp) => IMessagePlatform) & { config(): unknown };

const spectrumFactory = Spectrum as unknown as SpectrumFactory;
const imessagePlatform = imessage as unknown as ImessagePlatformValue;

/** Build a live SpectrumPort from project credentials. Async because `Spectrum()` opens the connection. */
export async function createSpectrumPort(config: PhotonConfig): Promise<SpectrumPort> {
  const app = await spectrumFactory({
    projectId: config.projectId,
    projectSecret: config.projectSecret,
    platforms: [imessagePlatform.config()],
  });
  return new SpectrumCloudPort(app, imessagePlatform(app));
}

class SpectrumCloudPort implements SpectrumPort {
  /** One resolved conversation per handle — reused so repeated sends don't create new conversations. */
  private readonly spaces = new Map<string, Promise<SpectrumSpace>>();

  constructor(
    private readonly app: SpectrumApp,
    private readonly im: IMessagePlatform,
  ) {}

  private space(handle: string): Promise<SpectrumSpace> {
    let s = this.spaces.get(handle);
    if (!s) {
      s = this.im.space.create(handle);
      this.spaces.set(handle, s);
    }
    return s;
  }

  async send(handle: string, text: string): Promise<{ id?: string }> {
    const space = await this.space(handle);
    const msg = await this.app.send(space, text);
    return msg?.id !== undefined ? { id: msg.id } : {};
  }

  async *stream(): AsyncIterable<SpectrumInbound> {
    for await (const [, message] of this.im.messages) {
      // Only the operator's replies — never re-read our own outbound sends as a command.
      if (message.direction !== "inbound") continue;
      yield {
        text: extractText(message.content),
        senderHandle: message.sender?.address,
        id: message.id,
        ...(message.sender?.service ? { service: message.sender.service } : {}),
      };
    }
  }

  async close(): Promise<void> {
    await this.app.stop();
  }
}

/** Extract plain text from Spectrum's `Content` union; empty for non-text content (→ not an approval). */
function extractText(content: unknown): string {
  if (
    content !== null &&
    typeof content === "object" &&
    "type" in content &&
    (content as { type: unknown }).type === "text" &&
    "text" in content
  ) {
    return String((content as { text: unknown }).text ?? "");
  }
  return "";
}

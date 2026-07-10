/**
 * A tiny WebSocket seam.
 *
 * Discord's gateway and Slack's Socket Mode are both persistent outbound WebSockets. Node 22+ ships a
 * WHATWG `WebSocket` global (undici), so neither channel needs a third-party client library — the same
 * "use the platform, inject it for tests" choice the Telegram channel makes with `fetch`. `WebSocketLike`
 * is the exact subset both channels use; the default factory wraps the global, and a test injects a fake
 * so the gateway/socket lifecycle (identify, heartbeat, ack, reconnect) is exercised with no network.
 */

export interface WsMessageEvent {
  readonly data: unknown;
}
export interface WsCloseEvent {
  readonly code?: number;
  readonly reason?: string;
}

export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readonly readyState: number;
  addEventListener(type: "open", cb: () => void): void;
  addEventListener(type: "message", cb: (ev: WsMessageEvent) => void): void;
  addEventListener(type: "close", cb: (ev: WsCloseEvent) => void): void;
  addEventListener(type: "error", cb: (ev: unknown) => void): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export const defaultWebSocketFactory: WebSocketFactory = (url) =>
  new WebSocket(url) as unknown as WebSocketLike;

/** Normalize a frame's `data` (string, Buffer, or ArrayBuffer) to a UTF-8 string, or null if impossible. */
export function frameToString(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  }
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  return null;
}

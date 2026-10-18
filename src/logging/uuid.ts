import { getRandomValues } from "node:crypto";

/** RFC 9562 UUID version 7: 48-bit Unix milliseconds followed by random bits. */
export function uuidv7(timestamp: number = Date.now()): string {
  const bytes = getRandomValues(new Uint8Array(16));
  let remaining = BigInt(timestamp);
  for (let index = 5; index >= 0; index--) {
    bytes[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

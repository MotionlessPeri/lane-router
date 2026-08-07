export const DEFAULT_MAX_BATCH_COUNT = 64;
export const DEFAULT_MAX_BATCH_ENCODED_BYTES = 16_384;

export function wakeEnvelopeValue(deliveryIds: readonly string[], messageIds: readonly string[]): string {
  return JSON.stringify({ deliveryIds, messageIds });
}

export function wakeEnvelopeBytes(deliveryIds: readonly string[], messageIds: readonly string[]): number {
  return Buffer.byteLength(wakeEnvelopeValue(deliveryIds, messageIds), "utf8");
}

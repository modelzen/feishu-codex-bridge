/** Budget the fully woven text, including retrieved context and mention takeover. */
export const DISCUSS_DELIVERY_BYTES = 256 * 1024;
export class DiscussDeliveryBudgetError extends Error {
  constructor() { super('Discuss delivery exceeds 256 KiB; split the pending messages'); }
}
export function assertDiscussDeliveryBudget(text: string): void {
  if (Buffer.byteLength(text, 'utf8') > DISCUSS_DELIVERY_BYTES) throw new DiscussDeliveryBudgetError();
}

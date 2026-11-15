/** Acknowledged platform facts; planned text is never an acknowledged part. */
export interface ConfirmedDeliveryPart {
  messageId: number;
  text: string;
  partIndex: number;
}

export interface DeliveryIdentity { intentId: string; revision: number }
export interface DeliveryResult extends DeliveryIdentity {
  status: 'sent' | 'suppressed' | 'failed' | 'unknown';
  chatId: number;
  targetMessageId?: number;
  messageThreadId?: number;
  parts: ConfirmedDeliveryPart[];
  plannedPartCount: number;
  reason?: string;
  /** Original transport error is retained in-process, never serialized as a receipt. */
  error?: unknown;
}

export type SentDelivery = DeliveryResult & { status: 'sent'; messageId: number; text: string };

/** Compatibility boundary: old numeric consumers receive only real IDs or throw. */
export class DeliveryError extends Error {
  readonly delivery: 'not_sent' | 'rejected' | 'unknown';
  readonly code: string;
  constructor(readonly result: DeliveryResult) {
    super(result.error instanceof Error ? result.error.message : `delivery_${result.status}:${result.reason ?? 'unconfirmed'}`);
    this.name = 'DeliveryError';
    const original = result.error as { delivery?: unknown; code?: unknown } | undefined;
    this.delivery = result.status === 'unknown' ? 'unknown'
      : original?.delivery === 'rejected' ? 'rejected' : 'not_sent';
    this.code = typeof original?.code === 'string' ? original.code : `delivery_${result.status}`;
  }
}

export function requireSentDelivery(result: DeliveryResult): SentDelivery {
  const first = result.parts[0];
  if (result.status !== 'sent' || !first || result.parts.some(part => !Number.isSafeInteger(part.messageId) || part.messageId <= 0)) {
    throw new DeliveryError(result.status === 'sent'
      ? { ...result, status: 'unknown', reason: 'invalid_receipt', parts: [] } : result);
  }
  return { ...result, status: 'sent', messageId: first.messageId, text: result.parts.map(part => part.text).join('') };
}

/** Classify only at a transport boundary. Unclassified post-attempt errors are uncertain. */
export function deliveryFailureStatus(error: unknown, attempted: boolean): 'failed' | 'unknown' {
  if (error instanceof DeliveryError) return error.result.status === 'unknown' ? 'unknown' : 'failed';
  if (!attempted) return 'failed';
  const e = error as { delivery?: unknown; error_code?: unknown; message?: unknown } | null;
  if (e?.delivery === 'unknown') return 'unknown';
  if (e?.delivery === 'not_sent' || e?.delivery === 'rejected') return 'failed';
  if (typeof e?.error_code === 'number' && e.error_code >= 400 && e.error_code < 500) return 'failed';
  // grammY errors in existing adapters/tests also expose the explicit API rejection in message.
  if (typeof e?.message === 'string' && /(?:\b4\d\d\b.*(?:Bad Request|Forbidden|Too Many Requests)|\bBad Request:|\bForbidden:)/i.test(e.message)) return 'failed';
  return 'unknown';
}

export function isUnknownDelivery(error: unknown): boolean {
  return error instanceof DeliveryError && error.result.status === 'unknown';
}

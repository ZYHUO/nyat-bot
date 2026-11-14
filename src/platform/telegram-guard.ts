import { isPlatformInternalId } from './identity-store.js';
import { PlatformBoundaryError } from './types.js';

const ID_KEY = /(?:^|_)(?:id|ids)$/;
const JSON_CONTAINER_KEYS = new Set(['reply_parameters', 'reply_markup', 'entities', 'caption_entities', 'media', 'chat_permissions']);
const ASSET_KEYS = new Set(['file_id', 'photo', 'audio', 'video', 'voice', 'document', 'sticker', 'animation', 'thumbnail', 'media']);

function reservedIdentifier(value: unknown): boolean {
  if (typeof value === 'number') return isPlatformInternalId(value);
  if (typeof value !== 'string') return false;
  // Reject alternative numeric spellings too; no API relay may coerce them
  // back into a reserved ID after this boundary has inspected the payload.
  return isPlatformInternalId(value) || (value.trim() !== '' && isPlatformInternalId(Number(value)));
}

/** Last boundary before grammY's network call, including raw/context API calls. */
export function assertTelegramPayload(payload: unknown): void {
  const visit = (value: unknown, key: string, depth: number): void => {
    if (depth > 24) throw new PlatformBoundaryError('telegram_payload_too_deep', 'Telegram payload exceeds inspection depth');
    if (ID_KEY.test(key)) {
      const values = Array.isArray(value) ? value : [value];
      if (values.some(reservedIdentifier)) {
        throw new PlatformBoundaryError('telegram_platform_id_blocked', 'Platform internal identifiers cannot be sent to Telegram');
      }
    }
    if (typeof value === 'string') {
      if (ASSET_KEYS.has(key) && /^qq(?:[-+:]|\/\/)/i.test(value)) {
        throw new PlatformBoundaryError('telegram_platform_asset_blocked', 'QQ assets cannot be sent to Telegram');
      }
      if ((JSON_CONTAINER_KEYS.has(key) || ID_KEY.test(key)) && /^[\s]*[\[{]/.test(value)) {
        if (value.length > 128 * 1024) throw new PlatformBoundaryError('telegram_payload_too_large', 'Serialized Telegram payload exceeds inspection size');
        let decoded: unknown;
        try { decoded = JSON.parse(value); } catch { return; }
        visit(decoded, key, depth + 1);
      }
      return;
    }
    if (Array.isArray(value)) { for (const item of value) visit(item, key, depth + 1); return; }
    if (!value || typeof value !== 'object' || Buffer.isBuffer(value)) return;
    const prototype = Object.getPrototypeOf(value) as unknown;
    // InputFile and streams are opaque file containers, never identifier maps.
    if (prototype !== null && prototype !== Object.prototype) return;
    for (const [childKey, child] of Object.entries(value)) visit(child, childKey, depth + 1);
  };
  visit(payload, '', 0);
}

import { env } from '../env.js';

/** Error messages deliberately contain neither matched content nor credentials. */
export class OutboundPrivacyError extends Error {
  readonly code = 'outbound_privacy_blocked';
  constructor() { super('outbound_privacy_blocked'); this.name = 'OutboundPrivacyError'; }
}

const registeredSecrets = new Set<string>();
/** Called at startup for provider keys, whose dynamic names are outside the env schema. */
export function registerOutboundSecrets(values: Iterable<string>): void {
  for (const value of values) if (value.length >= 8) registeredSecrets.add(value);
}

function variants(text: string): string[] {
  const plain = text.replace(/\\([_.*[\]()~`>#+=|{}!\-])/g, '$1');
  let decoded = plain;
  try { decoded = decodeURIComponent(plain); } catch { /* Literal malformed URLs stay text. */ }
  return [text, plain, decoded];
}

const CREDENTIAL_PATTERNS = [
  /-----BEGIN (?:OPENSSH |RSA |EC |DSA |ENCRYPTED )?PRIVATE KEY-----/i,
  /\d{6,12}:[A-Za-z0-9_-]{30,}/,
  /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}={0,2}/i,
  /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]{6,}@/i,
  /(?:api[_ -]?key|access[_ -]?token|bot[_ -]?token|password|passwd|密码|密钥)\s*[:=：]\s*["']?[A-Za-z0-9_!@#$%+./=-]{12,}/i,
];

/** Defense in depth, not a semantic detector of all private information. */
export function containsOutboundSecret(text: string): boolean {
  const candidates = variants(text);
  if (candidates.some((value) => CREDENTIAL_PATTERNS.some((pattern) => pattern.test(value)))) return true;
  const secrets = new Set(registeredSecrets);
  for (const [key, value] of Object.entries(env())) {
    if (/(?:TOKEN|SECRET|PASSWORD|API_KEY)$/.test(key) && typeof value === 'string' && value.length >= 8) secrets.add(value);
    if (typeof value === 'string' && /(?:URL|PROXY)$/.test(key)) {
      try { const password = decodeURIComponent(new URL(value).password); if (password.length >= 8) secrets.add(password); }
      catch { /* Not a credential-bearing URL. */ }
    }
  }
  for (const secret of secrets) {
    if (candidates.some((value) => value.includes(secret))) return true;
    // Also stop simple encoding of known runtime credentials. Do not classify
    // arbitrary base64 (ordinary file handles, hashes) as private information.
    if (secret.length >= 16 && text.includes(Buffer.from(secret).toString('base64'))) return true;
  }
  return false;
}

export function assertOutboundText(text: string): void {
  if (containsOutboundSecret(text)) throw new OutboundPrivacyError();
}

/** Raw platform forwarding carries hidden text/media with no inspectable source grant. */
export function assertSameConversationForward(target: unknown, source: unknown): void {
  if ((typeof target !== 'number' && typeof target !== 'string') || !String(target).trim()
    || (typeof source !== 'number' && typeof source !== 'string') || String(target) !== String(source)) {
    throw new OutboundPrivacyError();
  }
}

/** Inspect visible structured fields, including serialized inline keyboards/media. */
export function assertOutboundPayload(payload: unknown): void {
  const walk = (value: unknown, depth: number): void => {
    if (depth > 24) throw new OutboundPrivacyError();
    if (typeof value === 'string') {
      assertOutboundText(value);
      if (/^\s*[\[{]/.test(value)) {
        if (value.length > 128 * 1024) throw new OutboundPrivacyError();
        let decoded: unknown;
        try { decoded = JSON.parse(value); } catch { return; }
        walk(decoded, depth + 1);
      }
      return;
    }
    if (Array.isArray(value)) { for (const entry of value) walk(entry, depth + 1); return; }
    if (!value || typeof value !== 'object' || Buffer.isBuffer(value)) return;
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return; // Files/streams are checked by the upload adapter.
    for (const entry of Object.values(value)) walk(entry, depth + 1);
  };
  walk(payload, 0);
}

export function assertOutboundFile(bytes: Buffer, name: string, caption?: string): void {
  assertOutboundText(name);
  if (caption) assertOutboundText(caption);
  // Scan textual exports before upload; never pretend this inspects OCR, audio,
  // archives or encrypted/binary documents.
  if (/\.(?:txt|md|csv|jsonl?|ya?ml|xml|log|[cm]?[jt]sx?|py|sh|ini|toml|env|pem|key)$/i.test(name) || /^\.?env(?:\.|$)/i.test(name)) {
    assertOutboundText(bytes.toString('utf8'));
  } else if (bytes.length <= 1024 * 1024 && !bytes.includes(0)) {
    try { assertOutboundText(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch (error) { if (error instanceof OutboundPrivacyError) throw error; }
  }
}

/** Search engines are a separate recipient; never export identifying queries. */
export function assertPublicSearchQuery(query: string): void {
  assertOutboundText(query);
  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(query)
    || /(?:^|\D)(?:\+?86[ -]?)?1[3-9]\d{9}(?!\d)/.test(query)
    || /(?:^|\D)\d{17}[\dXx](?!\d)/.test(query)
    || /(?:(?:私聊|私信)(?:里|中|的|内容|记录)|不要告诉|别告诉|保密|我的.{0,6}(?:家庭住址|身份证|银行卡|密码|病历))/.test(query)) {
    throw new OutboundPrivacyError();
  }
}

import { createHmac } from 'crypto';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/env.js', () => ({
  env: () => ({ MASTER_UID_EXTRA: [222, 333] }),
}));

const { validateInitData, isMaster } = await import('../../../src/admin/auth.js');

const BOT_TOKEN = 'test-b...BBCC';

function buildInitData(
  user: Record<string, unknown>,
  overrides?: Record<string, string>,
): string {
  const authDate = overrides?.auth_date ?? String(Math.floor(Date.now() / 1000));
  const userJson = JSON.stringify(user);

  const params: Record<string, string> = {
    auth_date: authDate,
    query_id: 'AAHdF6IQAAAAAN0XohDhdfTE',
    user: userJson,
    ...overrides,
  };
  delete params.hash;

  const entries = Object.entries(params).sort(([a], [b]) => a.localeCompare(b));
  const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join('\n');

  const secret = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const hash = createHmac('sha256', secret).update(dataCheckString).digest('hex');

  const qs = new URLSearchParams(params);
  qs.set('hash', hash);
  return qs.toString();
}

const testUser = { id: 12345, first_name: 'Test', username: 'testuser' };

describe('validateInitData', () => {
  it('returns user for valid initData', () => {
    const initData = buildInitData(testUser);
    const result = validateInitData(initData, BOT_TOKEN);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(12345);
    expect(result!.first_name).toBe('Test');
    expect(result!.username).toBe('testuser');
  });

  it('returns null for invalid hash', () => {
    const initData = buildInitData(testUser);
    const tampered = initData.replace(/hash=[^&]+/, 'hash=0000deadbeef');
    expect(validateInitData(tampered, BOT_TOKEN)).toBeNull();
  });

  it('returns null for expired auth_date', () => {
    const expired = String(Math.floor(Date.now() / 1000) - 90_000);
    const initData = buildInitData(testUser, { auth_date: expired });
    expect(validateInitData(initData, BOT_TOKEN)).toBeNull();
  });

  it('returns null when hash is missing', () => {
    const params = new URLSearchParams({
      auth_date: String(Math.floor(Date.now() / 1000)),
      user: JSON.stringify(testUser),
    });
    expect(validateInitData(params.toString(), BOT_TOKEN)).toBeNull();
  });
});

describe('isMaster', () => {
  it('allows the primary master UID', () => {
    expect(isMaster(12345, 12345)).toBe(true);
  });

  it('allows extra master UIDs even when MASTER_UID is unset', () => {
    expect(isMaster(222, 0)).toBe(true);
  });

  it('rejects users outside the configured master list', () => {
    expect(isMaster(444, 12345)).toBe(false);
  });
});

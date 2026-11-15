import { describe, expect, it, vi } from 'vitest';
vi.mock('../../../src/env.js', () => ({ env: () => ({ MONITOR_TOKEN: 'configuredMonitorCredential12345', ONEBOT_ACCESS_TOKEN: 'configuredWsCredential67890' }) }));
import { assertOutboundText, assertOutboundFile, assertOutboundPayload, assertPublicSearchQuery, registerOutboundSecrets } from '../../../src/shared/outbound-privacy.js';

describe('outbound privacy boundary', () => {
  const key = `sk-${'synthetic_test_only_'.repeat(3)}`;
  it.each([
    key,
    `-----BEGIN OPENSSH PRIVATE KEY-----\nsynthetic\n-----END OPENSSH PRIVATE KEY-----`,
    `123456789:${'A'.repeat(35)}`,
    'configuredMonitorCredential12345',
    encodeURIComponent('configuredWsCredential67890'),
    Buffer.from('configuredMonitorCredential12345').toString('base64'),
    key.replaceAll('_', '\\_'),
    'password=synthetic-password-12345',
    'redis://default:syntheticRedisPassword@localhost:6379/0',
  ])('blocks credentials without returning the matched text: %#', (secret) => {
    expect(() => assertOutboundText(`这里是 ${secret}`)).toThrow('outbound_privacy_blocked');
    try { assertOutboundText(secret); } catch (error) { expect(String(error)).not.toContain(secret); }
  });
  it('registers nonstandard provider credentials without exposing them', () => {
    registerOutboundSecrets(['opaque-provider-credential-000001']);
    expect(() => assertOutboundText('opaque-provider-credential-000001')).toThrow();
  });
  it('checks an entire text export, including content beyond the displayed preview', () => {
    expect(() => assertOutboundFile(Buffer.from('a'.repeat(20000) + '\n' + key), 'report.txt')).toThrow();
    // Known credentials cannot evade the guard by joining surrounding text.
    expect(() => assertOutboundFile(Buffer.from('a'.repeat(20000) + 'configuredMonitorCredential12345'), 'report.txt')).toThrow();
    expect(() => assertOutboundFile(Buffer.from('hello'), 'report.txt', key)).toThrow();
    expect(() => assertOutboundFile(Buffer.from(key), 'unknown')).toThrow();
  });
  it('checks nested and serialized Telegram payload fields', () => {
    expect(() => assertOutboundPayload({ text: 'safe', reply_markup: { inline_keyboard: [[{ text: key }]] } })).toThrow();
    expect(() => assertOutboundPayload({ media: JSON.stringify([{ caption: key }]) })).toThrow();
    const escaped = [...key].map(c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')).join('');
    expect(() => assertOutboundPayload({ media: '[{"caption":"' + escaped + '"}]' })).toThrow();
  });
  it('preserves ordinary speech, public IDs and safe files', () => {
    expect(() => assertOutboundText('每人14元。QQ群1234567，Telegram话题42。')).not.toThrow();
    expect(() => assertOutboundFile(Buffer.from('待办：周六去买菜'), 'notes.txt')).not.toThrow();
    expect(() => assertOutboundFile(Buffer.from('报告'), 'task-abcdefghijklmnopqrstuvwx.txt')).not.toThrow();
    expect(() => assertOutboundFile(Buffer.from([0, 255, 3]), 'image.png')).not.toThrow();
  });
  it.each(['请查我的邮箱 user@example.org', '这个手机号13800138000是谁的？', '私聊里说的病历怎么回事？', '身份证110101199001011234'])('rejects identifying search query %#', (query) => {
    expect(() => assertPublicSearchQuery(query)).toThrow();
  });
  it('allows a public factual search', () => expect(() => assertPublicSearchQuery('上海明天天气怎么样')).not.toThrow());
  it('allows public instructions about privacy features', () => expect(() => assertPublicSearchQuery('Telegram私聊怎么开启')).not.toThrow());
});

import { describe, expect, it, vi } from 'vitest';
vi.mock('../../../src/db/redis.js', () => ({ getRedis: vi.fn() }));
vi.mock('../../../src/platform/identity-store.js', () => ({ findConversationRef: vi.fn() }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { warn: vi.fn() } }));
import { decodeOneBotFileNotice } from '../../../src/platform/onebot-file-notice.js';

const group = { post_type: 'notice', notice_type: 'group_upload', self_id: 80001, group_id: 70001, user_id: 60001,
  time: 1730000000, file: { id: '0123456789abcdef0123456789abcdef', name: '报告.txt', size: 8, busid: 102 } };
describe('OneBot file notices', () => {
  it('decodes the pinned NapCat group_upload shape without inventing a native message ID', () => {
    const message = decodeOneBotFileNotice(group, '80001')!;
    expect(message.ref.conversation).toEqual({ platform: 'qq', accountId: '80001', idNamespace: 'qq-number', conversationKind: 'group', id: '70001' });
    expect(message.ref.id).toMatch(/^file:[a-f0-9]{64}$/);
    expect(message.sender.id).toBe('60001'); expect(message.timestampMs).toBe(1730000000000);
    expect(message.segments).toEqual([{ type: 'file', assetRef: group.file.id, fileName: '报告.txt', fileSize: 8 }]);
    expect(decodeOneBotFileNotice(structuredClone(group), '80001')?.ref.id).toBe(message.ref.id);
    expect(decodeOneBotFileNotice({ ...group, time: group.time + 1 }, '80001')?.ref.id).not.toBe(message.ref.id);
  });
  it('accepts standard URL-only offline_file through the same CDN boundary', () => {
    const message = decodeOneBotFileNotice({ ...group, notice_type: 'offline_file', group_id: undefined,
      file: { name: '报告.txt', size: 8, url: 'https://file.qq.com/download?id=1' } }, '80001')!;
    expect(message.ref.conversation.conversationKind).toBe('private'); expect(message.ref.conversation.id).toBe('60001');
    expect(message.segments[0]).toMatchObject({ type: 'file', url: 'https://file.qq.com/download?id=1' });
  });
  it.each([
    { self_id: 80002 }, { user_id: 80001 }, { user_id: 'bad' }, { group_id: null },
    { time: Infinity }, { time: -1 }, { notice_type: 'group_decrease' }, { post_type: 'message' },
    { file: { ...group.file, id: '/etc/passwd' } }, { file: { ...group.file, size: '8' } },
  ])('fails closed on malformed or foreign notices', patch => {
    expect(decodeOneBotFileNotice({ ...group, ...patch }, '80001')).toBeNull();
  });
  it('does not let offline files supply local/SSRF paths', () => {
    for (const url of ['file:///etc/passwd', 'http://127.0.0.1/a', 'https://evil.test/a']) {
      expect(decodeOneBotFileNotice({ ...group, notice_type: 'offline_file', file: { name: 'a', size: 1, url } }, '80001')).toBeNull();
    }
  });
});

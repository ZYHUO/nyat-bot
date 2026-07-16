import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockMuteUser = vi.fn();
const mockUnmuteUser = vi.fn();
const mockSavePref = vi.fn();
const mockDeletePref = vi.fn();
const mockSetBotTag = vi.fn();
const mockClearBotTag = vi.fn();
const mockApplyMood = vi.fn();
const mockReact = vi.fn().mockResolvedValue(true);
const mockGetMembers = vi.fn();

vi.mock('../../../src/tracking/user-profile.js', () => ({
  muteUser: (...a: unknown[]) => mockMuteUser(...a),
  unmuteUser: (...a: unknown[]) => mockUnmuteUser(...a),
  saveUserPreference: (...a: unknown[]) => mockSavePref(...a),
  deleteUserPreference: (...a: unknown[]) => mockDeletePref(...a),
  setBotTag: (...a: unknown[]) => mockSetBotTag(...a),
  clearBotTag: (...a: unknown[]) => mockClearBotTag(...a),
}));
vi.mock('../../../src/tracking/mood.js', () => ({
  applyMoodEvent: (...a: unknown[]) => mockApplyMood(...a),
}));
vi.mock('../../../src/bot/sender/telegram.js', () => ({
  reactToMessage: (...a: unknown[]) => mockReact(...a),
}));
vi.mock('../../../src/pipeline/context/manager.js', () => ({
  getGroupMembers: (...a: unknown[]) => mockGetMembers(...a),
}));

import { executeControlActions } from '../../../src/pipeline/control-actions.js';

const GROUP = -100123;
const DM = 1001;
const REQ = 555;
const MSG = 42;

describe('executeControlActions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReact.mockResolvedValue(true);
    mockGetMembers.mockResolvedValue([
      { uid: 777, username: 'xiaoming', fullName: '小明' },
      { uid: 888, username: 'bob', fullName: 'Bob' },
    ]);
  });

  it('mute self → level-2 mute on requester, 12h auto-expire + emoji ack, returns true', async () => {
    const ok = await executeControlActions([{ action: 'mute', controlTarget: 'self' }], GROUP, REQ, MSG);
    expect(ok).toBe(true);
    // 自我 mute 无时长 → 全静默但 12h 自动解(codex 无关;主人要求)
    expect(mockMuteUser).toHaveBeenCalledWith(GROUP, REQ, 2, { temporary: true, durationMs: 12 * 60 * 60_000 });
    expect(mockReact).toHaveBeenCalledWith(GROUP, MSG, '👌');
  });

  it('timed mute self → level-1 temporary with durationMs', async () => {
    await executeControlActions([{ action: 'mute', controlTarget: 'self', muteMinutes: 10 }], GROUP, REQ, MSG);
    expect(mockMuteUser).toHaveBeenCalledWith(GROUP, REQ, 1, { temporary: true, durationMs: 600_000 });
  });

  it('mute a named person → resolves @username to uid', async () => {
    const ok = await executeControlActions(
      [{ action: 'mute', controlTarget: 'user', controlContent: '@xiaoming' }], GROUP, REQ, MSG,
    );
    expect(ok).toBe(true);
    expect(mockMuteUser).toHaveBeenCalledWith(GROUP, 777, 2, undefined);
  });

  it('mute a person not in roster → skipped, returns false', async () => {
    mockGetMembers.mockResolvedValue([]);
    const ok = await executeControlActions(
      [{ action: 'mute', controlTarget: 'user', controlContent: '@ghost' }], GROUP, REQ, MSG,
    );
    expect(ok).toBe(false);
    expect(mockMuteUser).not.toHaveBeenCalled();
  });

  it('unmute self → unmuteUser on requester', async () => {
    await executeControlActions([{ action: 'unmute', controlTarget: 'self' }], GROUP, REQ, MSG);
    expect(mockUnmuteUser).toHaveBeenCalledWith(GROUP, REQ);
  });

  it('remember → saveUserPreference + ✍ ack', async () => {
    const ok = await executeControlActions([{ action: 'remember', controlContent: '我喜欢猫' }], GROUP, REQ, MSG);
    expect(ok).toBe(true);
    expect(mockSavePref).toHaveBeenCalledWith(GROUP, REQ, '我喜欢猫');
    expect(mockReact).toHaveBeenCalledWith(GROUP, MSG, '✍');
  });

  it('forget → deleteUserPreference', async () => {
    await executeControlActions([{ action: 'forget', controlContent: '生日' }], GROUP, REQ, MSG);
    expect(mockDeletePref).toHaveBeenCalledWith(GROUP, REQ, '生日');
  });

  it('mute is group-only — skipped in DM', async () => {
    const ok = await executeControlActions([{ action: 'mute', controlTarget: 'self' }], DM, REQ, MSG);
    expect(ok).toBe(false);
    expect(mockMuteUser).not.toHaveBeenCalled();
  });

  it('remember works in DM (not group-gated)', async () => {
    const ok = await executeControlActions([{ action: 'remember', controlContent: 'x' }], DM, REQ, MSG);
    expect(ok).toBe(true);
    expect(mockSavePref).toHaveBeenCalledWith(DM, REQ, 'x');
  });

  it('call_me in DM with new tag → setBotTag(DM,req,tag) + ✍ ack', async () => {
    const ok = await executeControlActions([{ action: 'call_me', controlContent: '猫哥' }], DM, REQ, MSG);
    expect(ok).toBe(true);
    expect(mockSetBotTag).toHaveBeenCalledWith(DM, REQ, '猫哥');
    expect(mockClearBotTag).not.toHaveBeenCalled();
    expect(mockReact).toHaveBeenCalledWith(DM, MSG, '✍');
  });

  it('call_me in DM with empty content → clearBotTag (回退群里外号)', async () => {
    const ok = await executeControlActions([{ action: 'call_me', controlContent: '' }], DM, REQ, MSG);
    expect(ok).toBe(true);
    expect(mockClearBotTag).toHaveBeenCalledWith(DM, REQ);
    expect(mockSetBotTag).not.toHaveBeenCalled();
  });

  it('call_me is DM-only — skipped in group', async () => {
    const ok = await executeControlActions([{ action: 'call_me', controlContent: '猫哥' }], GROUP, REQ, MSG);
    expect(ok).toBe(false);
    expect(mockSetBotTag).not.toHaveBeenCalled();
    expect(mockClearBotTag).not.toHaveBeenCalled();
  });

  it('empty action list → false, no side effects', async () => {
    const ok = await executeControlActions([], GROUP, REQ, MSG);
    expect(ok).toBe(false);
    expect(mockReact).not.toHaveBeenCalled();
  });
});

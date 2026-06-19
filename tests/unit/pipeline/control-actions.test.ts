import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockMuteUser = vi.fn();
const mockUnmuteUser = vi.fn();
const mockSavePref = vi.fn();
const mockDeletePref = vi.fn();
const mockApplyMood = vi.fn();
const mockReact = vi.fn().mockResolvedValue(true);
const mockGetMembers = vi.fn();

vi.mock('../../../src/tracking/user-profile.js', () => ({
  muteUser: (...a: unknown[]) => mockMuteUser(...a),
  unmuteUser: (...a: unknown[]) => mockUnmuteUser(...a),
  saveUserPreference: (...a: unknown[]) => mockSavePref(...a),
  deleteUserPreference: (...a: unknown[]) => mockDeletePref(...a),
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

  it('mute self → level-2 mute on requester + emoji ack, returns true', async () => {
    const ok = await executeControlActions([{ action: 'mute', controlTarget: 'self' }], GROUP, REQ, MSG);
    expect(ok).toBe(true);
    expect(mockMuteUser).toHaveBeenCalledWith(GROUP, REQ, 2, undefined);
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

  it('empty action list → false, no side effects', async () => {
    const ok = await executeControlActions([], GROUP, REQ, MSG);
    expect(ok).toBe(false);
    expect(mockReact).not.toHaveBeenCalled();
  });
});

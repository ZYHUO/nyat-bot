import { describe, expect, it } from 'vitest';
import {
  normalizeGroupIdInput,
  shouldResetPermissionState,
  buildPermissionEntries,
} from './permissions';

describe('permissions helpers', () => {
  it('normalizes minus signs and spaces', () => {
    expect(normalizeGroupIdInput(' －100 3579270814 ')).toBe('-1003579270814');
  });

  it('marks stale result when chat id changes', () => {
    expect(shouldResetPermissionState('-1001', '-1002')).toBe(true);
    expect(shouldResetPermissionState('-1001', '-1001')).toBe(false);
  });

  it('builds ordered permission entries with null fallback', () => {
    expect(buildPermissionEntries({ can_pin_messages: true })[0]).toEqual({
      key: 'can_be_edited',
      value: null,
    });
    expect(
      buildPermissionEntries({ can_pin_messages: true }).find((item) => item.key === 'can_pin_messages')
    ).toEqual({
      key: 'can_pin_messages',
      value: true,
    });
  });
});

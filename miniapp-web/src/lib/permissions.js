export const PERMISSION_KEYS = [
  'can_be_edited',
  'can_manage_chat',
  'can_delete_messages',
  'can_manage_video_chats',
  'can_restrict_members',
  'can_promote_members',
  'can_change_info',
  'can_invite_users',
  'can_post_stories',
  'can_edit_stories',
  'can_delete_stories',
  'can_post_messages',
  'can_edit_messages',
  'can_pin_messages',
  'can_manage_topics',
  'is_anonymous',
];

export function normalizeGroupIdInput(value) {
  return String(value ?? '')
    .trim()
    .replace(/[\u2212\uFF0D]/g, '-')
    .replace(/\s/g, '');
}

export function shouldResetPermissionState(lastCheckedChatId, currentChatId) {
  return normalizeGroupIdInput(lastCheckedChatId) !== normalizeGroupIdInput(currentChatId);
}

export function buildPermissionEntries(permissions = {}) {
  return PERMISSION_KEYS.map((key) => ({
    key,
    value: Object.prototype.hasOwnProperty.call(permissions, key) ? permissions[key] : null,
  }));
}

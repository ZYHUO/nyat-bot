/** Synthetic fixtures only: no production accounts, messages or credentials. */
export const groupEvent = {
  post_type: 'message', message_type: 'group', self_id: 80001,
  user_id: 60001, group_id: 70001, message_id: -90001, time: 1_800_000_000,
  sender: { nickname: 'Fixture user', card: 'Fixture member' },
  message: [
    { type: 'reply', data: { id: '-90000' } },
    { type: 'at', data: { qq: '80001' } },
    { type: 'text', data: { text: 'Can you explain this?' } },
  ],
};

export const privateEvent = {
  post_type: 'message', message_type: 'private', self_id: '80001',
  user_id: '70001', message_id: '90002', time: 1_800_000_000,
  sender: { nickname: 'Fixture user' }, message: 'hello',
};

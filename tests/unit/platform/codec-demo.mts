// Offline executable example: node --import tsx tests/unit/platform/codec-demo.mts
import assert from 'node:assert/strict';
import { conversationKey, createOneBotCodec, fromTelegramChatId, toTelegramChatId } from '../../../src/platform/index.js';
import { groupEvent } from './fixtures.js';

const codec = createOneBotCodec('80001');
const incoming = codec.normalize(groupEvent);
assert(incoming);
assert.equal(incoming.ref.conversation.conversationKind, 'group');
assert.notEqual(conversationKey(incoming.ref.conversation), conversationKey(fromTelegramChatId('80001', 70001)));
assert.throws(() => toTelegramChatId(incoming.ref.conversation));
const outbound = codec.encode({ action: 'send', conversation: incoming.ref.conversation, segments: [
  { type: 'reply', message: incoming.ref }, { type: 'text', text: 'Offline codec fixture succeeded.' },
] });
assert.equal(outbound.action, 'send_group_msg');
console.log(JSON.stringify({ offline: true, conversationKey: conversationKey(incoming.ref.conversation), outbound }, null, 2));

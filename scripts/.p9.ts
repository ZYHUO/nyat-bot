import { renderRoomAwareness } from '../src/subagent/room-awareness.js';
import { getBotUid } from '../src/bot/bot.js';
import { getRecentBotTextsInChat } from '../src/tracking/self-history.js';
const r = await renderRoomAwareness({ chatId: -1002750574953, botUid: getBotUid(), quoteMessageId: 1, recentBotTexts: getRecentBotTextsInChat(-1002750574953).slice(-12) });
console.log('P9 len=' + r.text.length + ' mine Gone=' + !r.text.includes('[念头]') + ' theirs=' + r.text.includes('[你刚才的念头]'));
process.exit(0);

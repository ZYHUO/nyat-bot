import { reflectChat } from './src/cron/deep-reflection.js';
const chatId = Number(process.argv[2]);
const t = await reflectChat(chatId);
console.log('inputTokens(approx):', t);

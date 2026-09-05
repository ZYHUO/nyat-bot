import 'dotenv/config';
const { runSkillDistill } = await import('../src/cron/skill-distill.js');
await runSkillDistill();
console.log('=== skill-distill done ===');
const { distillHobbies } = await import('../src/tracking/hobbies.js');
const h = await distillHobbies();
console.log('=== hobbies distilled ===', JSON.stringify(h, null, 2));

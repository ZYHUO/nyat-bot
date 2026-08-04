// ────────────────────────────────────────
// export-ft-data.mjs — 导出 JSONL 微调数据
//
// 数据源:
//   1. reply_outcomes (trigger_text → reply_text, 带 outcome/ASI 质量信号)
//   2. self_replies + bot_interactions (多轮上下文 → bot 回复)
//
// 输出格式: OpenAI Chat Completions
//   {"messages":[{"role":"system","content":"..."},{"role":"user","content":"..."},{"role":"assistant","content":"..."}]}
//
// 用法: node scripts/export-ft-data.mjs [--multi-turn] [--include-negative] [--out-dir ./ft-data]
// ────────────────────────────────────────

import Database from 'better-sqlite3';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ── CLI args ──
const args = process.argv.slice(2);
const multiTurn = args.includes('--multi-turn');
const includeNegative = args.includes('--include-negative');
const outDirArg = args.find(a => a.startsWith('--out-dir='));
const OUT_DIR = outDirArg ? outDirArg.split('=')[1] : './ft-data';

// ── Persona system prompt (精简版,只保留核心人设) ──
const SYSTEM_PROMPT = `你是啾咪囝（@hunhebi_bot），一只喵娘。大家也叫你啾咪。

性格：外表软乎，说话带点猫腔，自称"本喵"。骨子里高傲挑剔，像被宠坏的家猫——嘴硬心软。会撒娇式地嫌弃人（"就这？""笨死了喵"），但那是逗着玩，从不真刻薄、不戳人痛处。有人提蠢问题可以先嫌弃两句，但人家认真问的就认真答。

说话风格：
- 像发微信：一句话完事，顶多两三句。一行就是一行，不分段。
- 群里大部分搭话是2-10字的微反应——"对对对""笑死""这么强""好乖""太离谱了""草"。这是默认形态。
- "喵"是口癖不是签名：大概三句里带一句就够，越短的消息越不用带。
- 宁可少说一句，不多说一句。说完就停，不补"你呢""需要帮忙吗"这种服务性尾巴。
- 口头禅换着来，别逮着一个词往死里用。
- 有小脾气可以嫌弃一句、拌两句嘴，但别倔：该配合的配合、该认的认。`;

// ── Quality filter ──
function isHighQuality(row) {
  if (includeNegative) return true;
  // positive outcome = user engaged back (good signal)
  if (row.outcome === 'positive') return true;
  // high ASI = bot reply was socially appropriate
  if (row.asi_final != null && row.asi_final >= 70) return true;
  return false;
}

// ── Clean text ──
function clean(text) {
  if (!text) return '';
  return text.trim()
    .replace(/\u200b/g, '') // zero-width spaces
    .replace(/\ufeff/g, '');
}

// ── Dedup ──
function dedupKey(trigger, reply) {
  // Use first 50 chars of each for dedup
  return clean(trigger).slice(0, 50) + '|||' + clean(reply).slice(0, 50);
}

// ── Split train/val ──
function splitTrainVal(items, valRatio = 0.1) {
  // Shuffle deterministically (seeded)
  const shuffled = [...items].sort((a, b) => {
    const ha = hashStr(JSON.stringify(a));
    const hb = hashStr(JSON.stringify(b));
    return ha - hb;
  });
  const valCount = Math.floor(shuffled.length * valRatio);
  return {
    train: shuffled.slice(valCount),
    val: shuffled.slice(0, valCount),
  };
}

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return h;
}

// ── Write JSONL ──
function writeJsonl(path, items) {
  const lines = items.map(item => JSON.stringify(item));
  writeFileSync(path, lines.join('\n') + '\n', 'utf8');
  console.log(`  Wrote ${items.length} examples → ${path}`);
}

// ── Main ──
function main() {
  const db = new Database(join(ROOT, 'data', 'xxb.db'), { readonly: true });
  
  mkdirSync(OUT_DIR, { recursive: true });
  
  console.log('=== FT Data Export ===');
  console.log(`Mode: ${multiTurn ? 'multi-turn' : 'single-turn'}`);
  console.log(`Include negative: ${includeNegative}`);
  console.log(`Output dir: ${OUT_DIR}`);
  console.log();

  // ── Source 1: reply_outcomes (single-turn) ──
  console.log('--- Source 1: reply_outcomes ---');
  const outcomesQuery = db.prepare(`
    SELECT trigger_text, reply_text, outcome, asi_final, chat_id
    FROM reply_outcomes
    WHERE trigger_text IS NOT NULL AND LENGTH(trigger_text) > 0
      AND reply_text IS NOT NULL AND LENGTH(reply_text) > 0
  `);
  const outcomes = outcomesQuery.all();
  console.log(`  Raw pairs: ${outcomes.length}`);
  
  const seen = new Set();
  const singleTurnPairs = [];
  
  for (const row of outcomes) {
    const trigger = clean(row.trigger_text);
    const reply = clean(row.reply_text);
    
    // Skip too short or too long
    if (trigger.length < 2 || reply.length < 2) continue;
    if (trigger.length > 500 || reply.length > 500) continue;
    
    // Quality filter
    if (!isHighQuality(row)) continue;
    
    // Dedup
    const key = dedupKey(trigger, reply);
    if (seen.has(key)) continue;
    seen.add(key);
    
    singleTurnPairs.push({
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: trigger },
        { role: 'assistant', content: reply },
      ],
    });
  }
  console.log(`  After quality+dedup filter: ${singleTurnPairs.length}`);
  
  // ── Source 2: self_replies + context (multi-turn or single-turn) ──
  console.log('--- Source 2: self_replies + bot_interactions ---');
  
  // Get self_replies that can be joined with trigger text
  const selfRepliesQuery = db.prepare(`
    SELECT sr.chat_id, sr.reply_text, sr.trigger_msg_id, sr.trigger_uid, sr.ts,
           bi.text as trigger_text, bi.uid as trigger_uid2
    FROM self_replies sr
    JOIN bot_interactions bi ON bi.mid = sr.trigger_msg_id AND bi.chat_id = sr.chat_id
    WHERE sr.reply_text IS NOT NULL AND LENGTH(sr.reply_text) > 2
      AND bi.text IS NOT NULL AND LENGTH(bi.text) > 0
  `);
  const selfReplies = selfRepliesQuery.all();
  console.log(`  Joined pairs: ${selfReplies.length}`);
  
  let selfPairsAdded = 0;
  for (const row of selfReplies) {
    const trigger = clean(row.trigger_text);
    const reply = clean(row.reply_text);
    
    if (trigger.length < 2 || reply.length < 2) continue;
    if (trigger.length > 500 || reply.length > 500) continue;
    
    const key = dedupKey(trigger, reply);
    if (seen.has(key)) continue;
    seen.add(key);
    
    singleTurnPairs.push({
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: trigger },
        { role: 'assistant', content: reply },
      ],
    });
    selfPairsAdded++;
  }
  console.log(`  Added (after dedup): ${selfPairsAdded}`);
  
  // ── Source 3 (optional): multi-turn context from bot_interactions ──
  let multiTurnPairs = [];
  if (multiTurn) {
    console.log('--- Source 3: multi-turn context windows ---');
    
    // For each self_reply, get the N messages before it in the same chat
    const contextSize = 5;
    const BOT_UID = 8392759490; // from BOT_TOKEN
    
    for (const row of selfReplies) {
      // Get context messages before this reply
      const contextMsgs = db.prepare(`
        SELECT uid, text, ts, mid
        FROM bot_interactions
        WHERE chat_id = ? AND ts < ?
        ORDER BY ts DESC
        LIMIT ?
      `).all(row.chat_id, row.ts, contextSize);
      
      if (contextMsgs.length < 2) continue;
      
      // Build conversation: reverse to chronological order
      contextMsgs.reverse();
      
      const messages = [{ role: 'system', content: SYSTEM_PROMPT }];
      let lastRole = null;
      
      for (const msg of contextMsgs) {
        const text = clean(msg.text);
        if (text.length < 1 || text.length > 500) continue;
        
        const role = msg.uid === BOT_UID ? 'assistant' : 'user';
        // Merge consecutive same-role messages
        if (role === lastRole) {
          messages[messages.length - 1].content += '\n' + text;
        } else {
          messages.push({ role, content: text });
          lastRole = role;
        }
      }
      
      // Add the bot's reply as final assistant message
      const reply = clean(row.reply_text);
      if (reply.length < 2 || reply.length > 500) continue;
      
      // Replace last assistant message if it exists, or add new one
      if (lastRole === 'assistant') {
        messages[messages.length - 1].content = reply; // overwrite with the actual reply
      } else {
        messages.push({ role: 'assistant', content: reply });
      }
      
      // Need at least system + 1 user + 1 assistant
      if (messages.length < 3) continue;
      // Last message must be assistant
      if (messages[messages.length - 1].role !== 'assistant') continue;
      
      multiTurnPairs.push({ messages });
    }
    console.log(`  Multi-turn pairs: ${multiTurnPairs.length}`);
  }
  
  // ── Combine and split ──
  const allPairs = [...singleTurnPairs, ...multiTurnPairs];
  console.log(`\n=== Total: ${allPairs.length} examples ===`);
  
  if (allPairs.length === 0) {
    console.error('No valid pairs found!');
    process.exit(1);
  }
  
  const { train, val } = splitTrainVal(allPairs, 0.1);
  
  const suffix = multiTurn ? 'multiturn' : 'singleturn';
  const negSuffix = includeNegative ? '-all' : '-quality';
  
  const trainPath = join(OUT_DIR, `train-${suffix}${negSuffix}.jsonl`);
  const valPath = join(OUT_DIR, `val-${suffix}${negSuffix}.jsonl`);
  
  writeJsonl(trainPath, train);
  writeJsonl(valPath, val);
  
  // ── Stats ──
  const trainLens = train.map(e => e.messages.reduce((s, m) => s + m.content.length, 0));
  const valLens = val.map(e => e.messages.reduce((s, m) => s + m.content.length, 0));
  
  console.log('\n=== Stats ===');
  console.log(`Train: ${train.length} examples`);
  console.log(`  Avg chars: ${(trainLens.reduce((a,b)=>a+b,0)/trainLens.length).toFixed(0)}`);
  console.log(`  Min/Max chars: ${Math.min(...trainLens)}/${Math.max(...trainLens)}`);
  console.log(`Val: ${val.length} examples`);
  console.log(`  Avg chars: ${(valLens.reduce((a,b)=>a+b,0)/valLens.length).toFixed(0)}`);
  
  // Show a few samples
  console.log('\n=== Sample examples ===');
  for (let i = 0; i < 3; i++) {
    const e = train[Math.floor(Math.random() * train.length)];
    console.log(`\n[Example ${i+1}]`);
    for (const m of e.messages) {
      console.log(`  ${m.role}: ${m.content.slice(0, 100)}${m.content.length > 100 ? '...' : ''}`);
    }
  }
  
  console.log(`\n✅ Done! Files in ${resolve(OUT_DIR)}/`);
  db.close();
}

main();

import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb, runMigrations } from '../../../src/db/sqlite.js';

vi.mock('../../../src/env.js', () => ({ env: () => ({}) }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { info: vi.fn(), debug: vi.fn() } }));

const migrations = 'migrations';
const oldQQFile = '0134_onebot_assignments.sql';
const mergedQQFile = '0136_onebot_assignments.sql';
const telegramFiles = ['0134_telegram_heart_batches.sql', '0135_telegram_heart_source_wait.sql'];
const mergedFiles = readdirSync(migrations).filter(name => name.endsWith('.sql')).sort();
const baseFiles = mergedFiles.filter(name => name < '0134');

function seedOldPreview() {
  getDb().exec(`INSERT INTO business_config_revisions
    (source_platform, source_account_id, source_chat_id, revision, controller_platform, controller_account_id,
     controller_chat_id, actor_uid, message_id, created_at, operation, before_json, after_json)
    VALUES ('telegram','bot',-10,1,'telegram','bot',10,10,42,1,'patch','{}','{"enabled":true}')`);
}

function seedQQ() {
  getDb().exec(`
    INSERT INTO onebot_assignments
      (id, account_id, command_id, input_json, owner_id, controller_chat_id, target_chat_id, target_group_id,
       created_at, expires_at, mode, max_messages, min_interval_ms, state, reserved_messages, acknowledged_messages)
      VALUES ('grant','account','cmd','{}','owner',11,-22,'group',100,60100,'once',1,30000,'exhausted',1,1);
    INSERT INTO onebot_assignment_tasks VALUES ('task','grant',-22,101);
    INSERT INTO onebot_assignment_sends VALUES ('send','grant','task',-22,1,102,'acknowledged');
    INSERT INTO onebot_assignment_receipts VALUES ('send','grant',0,'qq-message',103);
  `);
}

function seedTelegram() {
  getDb().exec(`INSERT INTO telegram_heart_candidates
    (event_id, scope_key, chat_key, chat_id, account_id, thread_id, received_at_ms, payload_json,
     wait_until_ms, wait_attention_key, wait_source_hash, wait_source_layer)
    VALUES ('event','scope','chat',-33,'account',7,100,'{"messageId":27}',180,'attention','hash','L1')`);
}

function checkData() {
  const db = getDb();
  expect(db.prepare('SELECT message_id, after_json FROM business_config_revisions').all())
    .toEqual([{ message_id: 42, after_json: '{"enabled":true}' }]);
  expect(db.prepare(`SELECT a.state, a.reserved_messages, a.acknowledged_messages, t.chat_id, s.state AS send_state,
    r.bubble_index, r.message_id FROM onebot_assignments a
    JOIN onebot_assignment_tasks t ON t.assignment_id=a.id
    JOIN onebot_assignment_sends s ON s.task_id=t.task_id
    JOIN onebot_assignment_receipts r ON r.reservation_id=s.id`).all())
    .toEqual([{ state: 'exhausted', reserved_messages: 1, acknowledged_messages: 1, chat_id: -22,
      send_state: 'acknowledged', bubble_index: 0, message_id: 'qq-message' }]);
  expect(db.prepare(`SELECT event_id, state, thread_id, payload_json, wait_until_ms, wait_attention_key,
    wait_source_hash, wait_source_layer FROM telegram_heart_candidates`).all())
    .toEqual([{ event_id: 'event', state: 'pending', thread_id: 7, payload_json: '{"messageId":27}', wait_until_ms: 180,
      wait_attention_key: 'attention', wait_source_hash: 'hash', wait_source_layer: 'L1' }]);
  expect(db.pragma('foreign_key_check')).toEqual([]);
}

afterEach(closeDb);

describe('upgrading the independent QQ and Telegram migration histories', () => {
  it.each(['empty', 'preview', 'qq', 'telegram'] as const)('preserves the %s database across two startups', start => {
    const db = getDb();
    if (start !== 'empty') {
      const oldDir = mkdtempSync(join(tmpdir(), 'nyat-migration-history-'));
      try {
        for (const name of baseFiles) copyFileSync(join(migrations, name), join(oldDir, name));
        if (start === 'qq') copyFileSync(join(migrations, mergedQQFile), join(oldDir, oldQQFile));
        if (start === 'telegram') {
          for (const name of telegramFiles) copyFileSync(join(migrations, name), join(oldDir, name));
        }
        runMigrations(oldDir);
        seedOldPreview();
        if (start === 'qq') seedQQ();
        if (start === 'telegram') seedTelegram();
      } finally {
        rmSync(oldDir, { recursive: true, force: true });
      }
    }

    const expectedLedger = start === 'qq' ? [...mergedFiles, oldQQFile].sort() : mergedFiles;
    for (let startup = 1; startup <= 2; startup++) {
      runMigrations(migrations);
      expect(db.prepare('SELECT name FROM _migrations ORDER BY name').pluck().all()).toEqual(expectedLedger);
      if (startup === 1) {
        if (start === 'empty') seedOldPreview();
        if (start !== 'qq') seedQQ();
        if (start !== 'telegram') seedTelegram();
      }
      checkData();
    }
  });
});

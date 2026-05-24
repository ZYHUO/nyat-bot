const Database = require("better-sqlite3");
const db = new Database("/root/xxb-ts/data/xxb.db");
const now = Math.floor(Date.now() / 1000);
db.prepare("INSERT OR REPLACE INTO group_verify_settings (chat_id, enabled, timeout_seconds, max_attempts, kick_on_fail, updated_at) VALUES (?, 1, 300, 3, 0, ?)").run(-1003710566176, now);
const row = db.prepare("SELECT * FROM group_verify_settings WHERE chat_id = ?").get(-1003710566176);
console.log("Settings:", JSON.stringify(row));
db.close();

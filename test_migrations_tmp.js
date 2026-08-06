const Database = require('better-sqlite3');
const fs = require('fs');
const db = new Database(':memory:');
const files = ['migrations/0054_episodes_experience.sql','migrations/0055_goals.sql','migrations/0056_self_model.sql'];
for (const f of files) {
  const sql = fs.readFileSync(f,'utf-8');
  db.exec(sql);
  console.log('Applied:', f);
}
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r=>r.name);
console.log('Tables:', tables.join(', '));
const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name").all().map(r=>r.name);
console.log('Triggers:', triggers.join(', '));
const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r=>r.name);
console.log('Indexes:', indexes.join(', '));
db.prepare('INSERT INTO episodes (task_id, chat_id, goal, outcome, summary, created_at) VALUES (?,?,?,?,?,?)').run('t1',-100,'test goal','done','test summary',123);
db.prepare('INSERT INTO experience_entries (kind, content, tags, source_episode_id, created_at) VALUES (?,?,?,?,?)').run('trick','write file then sendfile','[]',1,123);
const fts = db.prepare("SELECT e.id, e.content FROM experience_fts f JOIN experience_entries e ON e.id = f.rowid WHERE experience_fts MATCH ?").all('"write" OR "sendfile"');
console.log('FTS search result count:', fts.length);
db.prepare('INSERT INTO goals (topic, origin, status, created_at, updated_at) VALUES (?,?,?,?,?)').run('test topic','self','active',123,123);
const goals = db.prepare('SELECT * FROM goals').all();
console.log('Goals:', goals.length);
db.prepare('INSERT INTO self_model_notes (note, evidence, created_at) VALUES (?,?,?)').run('be concise','evidence',123);
const notes = db.prepare('SELECT * FROM self_model_notes').all();
console.log('Self notes:', notes.length);
for (const f of files) {
  const sql = fs.readFileSync(f,'utf-8');
  db.exec(sql);
  console.log('Re-applied (idempotent):', f);
}
db.close();

/** SQLite-only worker (avoids tsx resolving NyatDB .ts in worker_threads). */
import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';

const data = workerData as {
  sqlitePath: string;
  chatId: number;
  ids: number[];
};

const sqlite = new Database(data.sqlitePath, { readonly: true, fileMustExist: true });
const get = sqlite.prepare(`SELECT text FROM messages WHERE chat_id=? AND message_id=?`);
for (const id of data.ids) get.get(data.chatId, id);
sqlite.close();
parentPort?.postMessage('ok');

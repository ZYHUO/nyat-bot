/** NyatDB on-disk constants — NyatBot-only page engine. */

export const PAGE_SIZE = 4096;
export const PAGE_MAGIC = Buffer.from('NYP1'); // Nyat Page v1
export const WAL_MAGIC = Buffer.from('NW1\0');
export const SCHEMA_VERSION = 3;

/** Fixed header before tuple area. */
export const PAGE_HEADER_SIZE = 64;

export const enum PageType {
  Free = 0,
  Super = 1,
  Chat = 2,
  Hot = 3,
  Impulse = 4,
  Bond = 5,
  Recall = 6,
  Catalog = 7,
}

export const enum WalType {
  AllocPage = 1,
  InsertTuple = 2,
  SetHot = 3,
  EnqueueImpulse = 4,
  AckImpulse = 5,
  UpsertBond = 6,
  UpsertRecall = 7,
  Checkpoint = 8,
  LinkChatPage = 9,
  DelHot = 10,
  TrimChat = 11,
}

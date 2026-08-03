//! NyatDB's domain engine: page-backed data structures, redo replay, and snapshots.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::constants::{PageType, SCHEMA_VERSION, WalType};
use crate::codec::{
  cosine, decode_bond, decode_chat_tuple, decode_hot, decode_impulse, decode_recall, encode_bond,
  encode_chat_tuple, encode_hot, encode_impulse, encode_recall, BondTuple, ChatTuple, ImpulseTuple,
  RecallRec,
};
use crate::error::{NyatError, Result};
use crate::heap::HeapFile;
use crate::msg_index::{load_msg_index, save_msg_index, unpack_loc, CompactMsgIndex};
use crate::page::Page;
use crate::pool::BufferPool;
use crate::wal::RedoWal;

const ROOT_PAGES: u32 = 5;

#[derive(Clone, Debug)]
pub struct OpenOpts {
    pub path: PathBuf,
    pub sync_every: u32,
    pub pool_frames: u32,
    pub chat_ring_max: u32,
    pub verify_on_open: bool,
}

#[derive(Clone, Copy, Debug)]
pub struct ChatTip {
    pub head: u32,
    pub tail: u32,
    pub count: u32,
}

#[derive(Clone, Debug)]
pub struct EngineStats {
    pub pages: u32,
    pub chats: u32,
    pub recalls: u32,
    pub indexed: u32,
    pub lsn: u64,
    pub pool: (usize, usize),
}

#[derive(Serialize, Deserialize)]
struct EngineMeta {
    schema: u32,
    lsn: String,
    checkpoint_lsn: String,
}

pub struct Engine {
    pub path: PathBuf,
    heap: HeapFile,
    wal: RedoWal,
    pool: BufferPool,
    sync_every: u32,
    appends: u32,
    pub lsn: u64,
    pub checkpoint_lsn: u64,
    pub chat_ring_max: u32,
    closed: bool,
    chat_tips: HashMap<i64, ChatTip>,
    chat_recent_ring: HashMap<i64, Vec<ChatTuple>>,
    msg_index: CompactMsgIndex,
    hot_index: HashMap<String, u32>,
    hot_page_id: u32,
    impulse_page_id: u32,
    bond_page_id: u32,
    recall_page_id: u32,
    recall_mem: Vec<RecallRec>,
}

impl Engine {
    pub fn open(opts: OpenOpts) -> Result<Self> {
        fs::create_dir_all(&opts.path)?;
        let mut start_lsn = 1;
        let mut checkpoint_lsn = 0;
        let meta_path = opts.path.join("ENGINE.json");
        if meta_path.exists() {
            if let Ok(meta) = serde_json::from_str::<EngineMeta>(&fs::read_to_string(&meta_path)?) {
                start_lsn = meta.lsn.parse().unwrap_or(1);
                checkpoint_lsn = meta.checkpoint_lsn.parse().unwrap_or(0);
            }
        }

        // A skipped checkpoint has no updated meta file, so continue after its WAL.
        let replay = RedoWal::replay(&opts.path.join("wal").join("redo.wal"))?;
        let wal_lsn = replay.iter().map(|r| r.lsn + 1).max().unwrap_or(start_lsn);
        let heap = HeapFile::open(&opts.path)?;
        let wal = RedoWal::open(&opts.path.join("wal"), start_lsn.max(wal_lsn))?;
        let pool = BufferPool::new(opts.pool_frames as usize);
        let mut engine = Self {
            path: opts.path,
            heap,
            wal,
            pool,
            sync_every: opts.sync_every.max(1),
            appends: 0,
            lsn: start_lsn.max(wal_lsn),
            checkpoint_lsn,
            chat_ring_max: opts.chat_ring_max.max(50),
            closed: false,
            chat_tips: HashMap::new(),
            chat_recent_ring: HashMap::new(),
            msg_index: CompactMsgIndex::new(),
            hot_index: HashMap::new(),
            hot_page_id: 1,
            impulse_page_id: 2,
            bond_page_id: 3,
            recall_page_id: 4,
            recall_mem: Vec::new(),
        };
        engine.bootstrap_roots()?;
        engine.rebuild_from_heap()?;
        engine.msg_index =
            load_msg_index(&engine.path, checkpoint_lsn)?.unwrap_or_else(CompactMsgIndex::new);
        if engine.msg_index.size() == 0 {
            engine.rebuild_msg_index()?;
        }
        engine.replay_wal(&replay)?;
        engine.warm_chat_rings()?;
        if opts.verify_on_open {
            engine.verify()?;
        }
        Ok(engine)
    }

    fn now_ms() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
    }

    fn bootstrap_roots(&mut self) -> Result<()> {
        let types = [
            PageType::Super,
            PageType::Hot,
            PageType::Impulse,
            PageType::Bond,
            PageType::Recall,
        ];
        while self.heap.size_pages() < ROOT_PAGES {
            let id = self.heap.size_pages();
            let mut page = Page::alloc(id, types[id as usize]);
            self.heap.append_page(&mut page)?;
        }
        self.hot_page_id = 1;
        self.impulse_page_id = 2;
        self.bond_page_id = 3;
        self.recall_page_id = 4;
        Ok(())
    }

    fn rebuild_from_heap(&mut self) -> Result<()> {
        self.chat_tips.clear();
        self.hot_index.clear();
        self.recall_mem.clear();
        let mut chats: HashMap<i64, Vec<u32>> = HashMap::new();
        for page_id in 1..self.heap.size_pages() {
            let page = match self.heap.read_page(page_id, false) {
                Ok(page) => page,
                Err(_) => continue,
            };
            match page.page_type() {
                PageType::Chat => chats.entry(page.read_i64_at(32)).or_default().push(page_id),
                PageType::Hot => {
                    for tuple in page.all_tuples() {
                        if let Ok((key, _, _)) = decode_hot(&tuple) {
                            self.hot_index.insert(key, page_id);
                        }
                    }
                }
                PageType::Recall => {
                    for tuple in page.all_tuples() {
                        if let Ok(rec) = decode_recall(&tuple) {
                            self.recall_mem.retain(|x| {
                                !(x.chat_id == rec.chat_id && x.message_id == rec.message_id)
                            });
                            self.recall_mem.push(rec);
                        }
                    }
                }
                _ => {}
            }
        }
        for (chat_id, mut ids) in chats {
            ids.sort_unstable();
            let mut count = 0;
            for &id in &ids {
                count += self.heap.read_page(id, false)?.nslots() as u32;
            }
            for (i, &id) in ids.iter().enumerate() {
                let next = ids.get(i + 1).copied().unwrap_or(0);
                let frame = self.pool.get(&mut self.heap, id)?;
                frame.page.set_next(next);
                self.pool.unpin(id, true);
            }
            self.chat_tips.insert(
                chat_id,
                ChatTip {
                    head: ids[0],
                    tail: *ids.last().unwrap(),
                    count,
                },
            );
        }
        Ok(())
    }

    fn rebuild_msg_index(&mut self) -> Result<()> {
        self.msg_index.clear();
        for page_id in 1..self.heap.size_pages() {
            let page = match self.heap.read_page(page_id, false) {
                Ok(page) if page.page_type() == PageType::Chat => page,
                _ => continue,
            };
            let chat_id = page.read_i64_at(32);
            for slot in 0..page.nslots() {
                if let Some(tuple) = page.get_tuple(slot) {
                    if let Ok(msg) = decode_chat_tuple(&tuple) {
                        self.msg_index.set(chat_id, msg.message_id, page_id, slot);
                    }
                }
            }
        }
        Ok(())
    }

    fn freelist_head(&mut self) -> Result<u32> {
        let head = self.pool.get(&mut self.heap, 0)?.page.read_u32_at(32);
        self.pool.unpin(0, false);
        Ok(head)
    }

    fn set_freelist_head(&mut self, head: u32) -> Result<()> {
        self.pool
            .get(&mut self.heap, 0)?
            .page
            .write_u32_at(32, head);
        self.pool.unpin(0, true);
        Ok(())
    }

    fn alloc_page(&mut self, ty: PageType) -> Result<u32> {
        let head = self.freelist_head()?;
        if head != 0 {
            let next = self.pool.get(&mut self.heap, head)?.page.next_page_id();
            let fresh = Page::alloc(head, ty);
            self.pool.get(&mut self.heap, head)?.page.copy_from(&fresh);
            self.pool.unpin(head, true);
            self.pool.unpin(head, false);
            self.set_freelist_head(next)?;
            Ok(head)
        } else {
            let mut page = Page::alloc(self.heap.size_pages(), ty);
            self.heap.append_page(&mut page)
        }
    }

    fn free_page(&mut self, page_id: u32) -> Result<()> {
        if page_id < ROOT_PAGES {
            return Ok(());
        }
        let head = self.freelist_head()?;
        let mut fresh = Page::alloc(page_id, PageType::Free);
        fresh.set_next(head);
        self.pool
            .get(&mut self.heap, page_id)?
            .page
            .copy_from(&fresh);
        self.pool.unpin(page_id, true);
        self.set_freelist_head(page_id)
    }

    fn log(&mut self, ty: WalType, payload: &[u8]) -> Result<u64> {
        self.ensure_open()?;
        let lsn = self.wal.append(ty, payload)?;
        self.lsn = lsn + 1;
        self.appends += 1;
        if self.appends >= self.sync_every {
            self.wal.sync()?;
            self.appends = 0;
        }
        Ok(lsn)
    }

    fn replay_wal(&mut self, records: &[crate::wal::WalRecord]) -> Result<()> {
        for record in records {
            if record.lsn < self.checkpoint_lsn {
                continue;
            }
            self.apply_wal(record.ty, &record.payload, record.lsn)?;
            self.lsn = self.lsn.max(record.lsn + 1);
        }
        Ok(())
    }

    fn apply_wal(&mut self, ty: WalType, payload: &[u8], lsn: u64) -> Result<()> {
        match ty {
            WalType::InsertTuple => {
                if payload.len() < 12 {
                    return Err(NyatError::Msg("InsertTuple short".into()));
                }
                let page_id = u32::from_le_bytes(payload[0..4].try_into().unwrap());
                let chat_id = i64::from_le_bytes(payload[4..12].try_into().unwrap());
                let tuple = &payload[12..];
                let msg = decode_chat_tuple(tuple)?;
                self.heap.ensure_page_count(page_id + 1)?;
                let frame = self.pool.get(&mut self.heap, page_id)?;
                if frame.page.page_type() == PageType::Free || frame.page.nslots() == 0 {
                    frame.page.set_type(PageType::Chat);
                    frame.page.write_i64_at(32, chat_id);
                }
                let existing = (0..frame.page.nslots()).find(|&slot| {
                    frame
                        .page
                        .get_tuple(slot)
                        .and_then(|v| decode_chat_tuple(&v).ok())
                        .is_some_and(|item| item.message_id == msg.message_id)
                });
                let slot = existing.or_else(|| frame.page.insert(tuple));
                frame.page.set_lsn(lsn);
                self.pool.unpin(page_id, true);
                if let Some(slot) = slot {
                    self.msg_index.set(chat_id, msg.message_id, page_id, slot);
                    let tip = self.chat_tips.entry(chat_id).or_insert(ChatTip {
                        head: page_id,
                        tail: page_id,
                        count: 0,
                    });
                    if existing.is_none() {
                        tip.count += 1;
                    }
                    tip.tail = tip.tail.max(page_id);
                }
            }
            WalType::LinkChatPage => {
                if payload.len() < 16 {
                    return Err(NyatError::Msg("LinkChatPage short".into()));
                }
                let chat_id = i64::from_le_bytes(payload[0..8].try_into().unwrap());
                let page_id = u32::from_le_bytes(payload[8..12].try_into().unwrap());
                let prev_tail = u32::from_le_bytes(payload[12..16].try_into().unwrap());
                self.heap.ensure_page_count(page_id + 1)?;
                let frame = self.pool.get(&mut self.heap, page_id)?;
                frame.page.set_type(PageType::Chat);
                frame.page.write_i64_at(32, chat_id);
                frame.page.set_lsn(lsn);
                self.pool.unpin(page_id, true);
                if prev_tail != 0 {
                    self.pool
                        .get(&mut self.heap, prev_tail)?
                        .page
                        .set_next(page_id);
                    self.pool.unpin(prev_tail, true);
                }
                let tip = self.chat_tips.entry(chat_id).or_insert(ChatTip {
                    head: page_id,
                    tail: page_id,
                    count: 0,
                });
                if tip.head == 0 {
                    tip.head = page_id;
                }
                tip.tail = page_id;
            }
            WalType::SetHot => {
                let (key, value, expires_at) = decode_hot(payload)?;
                self.write_hot_local(&key, &value, expires_at, lsn)?;
            }
            WalType::DelHot => self.delete_hot_local(&String::from_utf8_lossy(payload), lsn)?,
            WalType::AckImpulse => {
                self.remove_impulse_local(&String::from_utf8_lossy(payload), lsn)?
            }
            WalType::TrimChat => {
                if payload.len() < 12 {
                    return Err(NyatError::Msg("TrimChat short".into()));
                }
                let chat_id = i64::from_le_bytes(payload[0..8].try_into().unwrap());
                let keep = u32::from_le_bytes(payload[8..12].try_into().unwrap()) as usize;
                self.trim_chat_local(chat_id, keep)?;
            }
            WalType::EnqueueImpulse => {
                self.insert_into_chain(self.impulse_page_id, PageType::Impulse, payload, lsn)?;
            }
            WalType::UpsertBond => {
                self.insert_into_chain(self.bond_page_id, PageType::Bond, payload, lsn)?;
            }
            WalType::UpsertRecall => {
                let rec = decode_recall(payload)?;
                self.recall_mem
                    .retain(|x| !(x.chat_id == rec.chat_id && x.message_id == rec.message_id));
                self.recall_mem.push(rec);
                self.insert_into_chain(self.recall_page_id, PageType::Recall, payload, lsn)?;
            }
            WalType::Checkpoint => self.checkpoint_lsn = lsn + 1,
            WalType::AllocPage => {}
        }
        Ok(())
    }

    fn insert_into_chain(
        &mut self,
        root: u32,
        ty: PageType,
        tuple: &[u8],
        lsn: u64,
    ) -> Result<u32> {
        let mut page_id = root;
        loop {
            let inserted = {
                let frame = self.pool.get(&mut self.heap, page_id)?;
                if frame.page.page_type() == PageType::Free {
                    frame.page.set_type(ty);
                }
                let slot = frame.page.insert(tuple);
                if slot.is_some() {
                    frame.page.set_lsn(lsn);
                }
                let next = frame.page.next_page_id();
                self.pool.unpin(page_id, slot.is_some());
                (slot, next)
            };
            if inserted.0.is_some() {
                return Ok(page_id);
            }
            if inserted.1 != 0 {
                page_id = inserted.1;
                continue;
            }
            let new_id = self.alloc_page(ty)?;
            self.pool
                .get(&mut self.heap, page_id)?
                .page
                .set_next(new_id);
            self.pool.unpin(page_id, true);
            let frame = self.pool.get(&mut self.heap, new_id)?;
            if frame.page.insert(tuple).is_none() {
                self.pool.unpin(new_id, false);
                return Err(NyatError::Msg("tuple too large for page".into()));
            }
            frame.page.set_lsn(lsn);
            self.pool.unpin(new_id, true);
            return Ok(new_id);
        }
    }

    fn write_hot_local(
        &mut self,
        key: &str,
        value: &[u8],
        expires_at: u64,
        lsn: u64,
    ) -> Result<()> {
        let tuple = encode_hot(key, value, expires_at);
        let page_id = self.hot_page_id;

        // Phase 1: Walk the full page chain, collect all non-matching tuples,
        // and clear every page in the chain. The old MVP code only looked at
        // page 1 and dropped all other keys on overflow — a silent data-loss bug.
        let mut kept: Vec<Vec<u8>> = Vec::new();
        let mut chain_page_id = page_id;
        loop {
            let cf = self.pool.get(&mut self.heap, chain_page_id)?;
            for t in cf.page.all_tuples() {
                if let Some((existing, _, _)) = decode_hot(&t) {
                    if existing != key {
                        kept.push(t);
                    }
                } else {
                    kept.push(t);
                }
            }
            let next = cf.page.next_page_id();
            // Clear the page and break the chain link.
            let cleared = Page::alloc(chain_page_id, PageType::Hot);
            cf.page.copy_from(&cleared);
            cf.page.set_lsn(lsn);
            self.pool.unpin(chain_page_id, true);
            if next == 0 {
                break;
            }
            chain_page_id = next;
        }

        // Phase 2: Re-insert all kept tuples + the new tuple via insert_into_chain.
        kept.push(tuple);
        for t in &kept {
            self.insert_into_chain(page_id, PageType::Hot, t, lsn)?;
        }

        self.hot_index.insert(key.to_owned(), page_id);
        Ok(())
    }

    fn delete_hot_local(&mut self, key: &str, lsn: u64) -> Result<()> {
        let start_page_id = *self.hot_index.get(key).unwrap_or(&self.hot_page_id);
        // Walk the full chain — the key may be on an overflow page.
        let mut page_id = start_page_id;
        loop {
            let frame = self.pool.get(&mut self.heap, page_id)?;
            let mut found = false;
            let kept: Vec<Vec<u8>> = frame
                .page
                .all_tuples()
                .into_iter()
                .filter(|t| {
                    decode_hot(t)
                        .map(|(existing, _, _)| {
                            if existing == key {
                                found = true;
                                false
                            } else {
                                true
                            }
                        })
                        .unwrap_or(true)
                })
                .collect();
            if found {
                let mut fresh = Page::alloc(page_id, PageType::Hot);
                for item in kept {
                    let _ = fresh.insert(&item);
                }
                fresh.set_lsn(lsn);
                frame.page.copy_from(&fresh);
            }
            let next = frame.page.next_page_id();
            self.pool.unpin(page_id, found);
            if next == 0 {
                break;
            }
            page_id = next;
        }
        self.hot_index.remove(key);
        Ok(())
    }

    fn remove_impulse_local(&mut self, id: &str, lsn: u64) -> Result<()> {
        let mut page_id = self.impulse_page_id;
        let mut seen = HashSet::new();
        while page_id != 0 && seen.insert(page_id) {
            let frame = self.pool.get(&mut self.heap, page_id)?;
            let next = frame.page.next_page_id();
            let kept: Vec<Vec<u8>> = frame
                .page
                .all_tuples()
                .into_iter()
                .filter(|t| decode_impulse(t).map(|job| job.id != id).unwrap_or(true))
                .collect();
            let mut fresh = Page::alloc(page_id, PageType::Impulse);
            fresh.set_next(next);
            for item in kept {
                let _ = fresh.insert(&item);
            }
            fresh.set_lsn(lsn);
            frame.page.copy_from(&fresh);
            self.pool.unpin(page_id, true);
            page_id = next;
        }
        Ok(())
    }

    pub fn chat_append(
        &mut self,
        chat_id: i64,
        message_id: u32,
        ts: u64,
        uid: u32,
        role: u8,
        text: String,
        body_json: bool,
    ) -> Result<()> {
        self.ensure_open()?;
        let tuple = encode_chat_tuple(&ChatTuple {
            message_id,
            ts,
            uid,
            role,
            text,
            body_json,
        })?;
        if !self.chat_tips.contains_key(&chat_id) {
            let page_id = self.alloc_page(PageType::Chat)?;
            self.pool
                .get(&mut self.heap, page_id)?
                .page
                .write_i64_at(32, chat_id);
            self.pool.unpin(page_id, true);
            let mut link = Vec::with_capacity(16);
            link.extend_from_slice(&chat_id.to_le_bytes());
            link.extend_from_slice(&page_id.to_le_bytes());
            link.extend_from_slice(&0u32.to_le_bytes());
            let lsn = self.log(WalType::LinkChatPage, &link)?;
            self.apply_wal(WalType::LinkChatPage, &link, lsn)?;
        }
        let mut page_id = self.chat_tips[&chat_id].tail;
        let mut slot = {
            let frame = self.pool.get(&mut self.heap, page_id)?;
            let slot = frame.page.insert(&tuple);
            self.pool.unpin(page_id, slot.is_some());
            slot
        };
        if slot.is_none() {
            let new_id = self.alloc_page(PageType::Chat)?;
            self.pool
                .get(&mut self.heap, new_id)?
                .page
                .write_i64_at(32, chat_id);
            self.pool.unpin(new_id, true);
            let mut link = Vec::with_capacity(16);
            link.extend_from_slice(&chat_id.to_le_bytes());
            link.extend_from_slice(&new_id.to_le_bytes());
            link.extend_from_slice(&page_id.to_le_bytes());
            let lsn = self.log(WalType::LinkChatPage, &link)?;
            self.apply_wal(WalType::LinkChatPage, &link, lsn)?;
            page_id = new_id;
            let frame = self.pool.get(&mut self.heap, page_id)?;
            slot = frame.page.insert(&tuple);
            self.pool.unpin(page_id, slot.is_some());
        }
        let slot = slot.ok_or_else(|| NyatError::Msg("chat tuple too large".into()))?;
        let mut payload = Vec::with_capacity(12 + tuple.len());
        payload.extend_from_slice(&page_id.to_le_bytes());
        payload.extend_from_slice(&chat_id.to_le_bytes());
        payload.extend_from_slice(&tuple);
        let lsn = self.log(WalType::InsertTuple, &payload)?;
        self.pool.get(&mut self.heap, page_id)?.page.set_lsn(lsn);
        self.pool.unpin(page_id, true);
        let tip = self.chat_tips.get_mut(&chat_id).unwrap();
        tip.tail = page_id;
        tip.count += 1;
        self.msg_index.set(chat_id, message_id, page_id, slot);
        self.push_chat_ring(chat_id, decode_chat_tuple(&tuple)?);
        Ok(())
    }

    fn push_chat_ring(&mut self, chat_id: i64, item: ChatTuple) {
        let ring = self.chat_recent_ring.entry(chat_id).or_default();
        ring.push(item);
        if ring.len() > self.chat_ring_max as usize {
            ring.drain(0..ring.len() - self.chat_ring_max as usize);
        }
    }

    fn warm_chat_rings(&mut self) -> Result<()> {
        self.chat_recent_ring.clear();
        for (&chat_id, &tip) in &self.chat_tips.clone() {
            let all = self.read_chat_chain(tip)?;
            let start = all.len().saturating_sub(self.chat_ring_max as usize);
            self.chat_recent_ring.insert(chat_id, all[start..].to_vec());
        }
        Ok(())
    }

    fn read_chat_chain(&mut self, tip: ChatTip) -> Result<Vec<ChatTuple>> {
        let mut page_id = tip.head;
        let mut seen = HashSet::new();
        let mut out = Vec::new();
        while page_id != 0 && seen.insert(page_id) {
            let frame = self.pool.get(&mut self.heap, page_id)?;
            let next = frame.page.next_page_id();
            for tuple in frame.page.all_tuples() {
                if let Ok(item) = decode_chat_tuple(&tuple) {
                    out.push(item);
                }
            }
            self.pool.unpin(page_id, false);
            page_id = next;
        }
        Ok(out)
    }

    pub fn chat_recent(&mut self, chat_id: i64, limit: usize) -> Result<Vec<ChatTuple>> {
        self.ensure_open()?;
        let want = if limit == 0 {
            self.chat_ring_max as usize
        } else {
            limit
        };
        let mut all = if let Some(ring) = self.chat_recent_ring.get(&chat_id) {
            if want <= ring.len() {
                ring.clone()
            } else {
                let Some(tip) = self.chat_tips.get(&chat_id).copied() else {
                    return Ok(Vec::new());
                };
                self.read_chat_chain(tip)?
            }
        } else {
            let Some(tip) = self.chat_tips.get(&chat_id).copied() else {
                return Ok(Vec::new());
            };
            self.read_chat_chain(tip)?
        };
        // Dual-write hole backfills may append out of arrival order — order by time/id.
        all.sort_by(|a, b| a.ts.cmp(&b.ts).then(a.message_id.cmp(&b.message_id)));
        let start = all.len().saturating_sub(self.chat_ring_max as usize);
        self.chat_recent_ring
            .insert(chat_id, all[start..].to_vec());
        Ok(all[all.len().saturating_sub(want)..].to_vec())
    }

    pub fn chat_get(&mut self, chat_id: i64, message_id: u32) -> Result<Option<ChatTuple>> {
        self.ensure_open()?;
        let Some(packed) = self.msg_index.get_packed(chat_id, message_id) else {
            return Ok(None);
        };
        let (page_id, slot) = unpack_loc(packed);
        let page = self.pool.peek(&mut self.heap, page_id)?;
        let Some(tuple) = page.get_tuple(slot) else {
            return Ok(None);
        };
        let item = decode_chat_tuple(&tuple)?;
        Ok((item.message_id == message_id).then_some(item))
    }

    /// Batch point-get: sequential page I/O under the engine lock, then rayon-parallel decode.
    pub fn chat_get_batch(
        &mut self,
        chat_id: i64,
        message_ids: &[u32],
    ) -> Result<Vec<Option<ChatTuple>>> {
        self.ensure_open()?;
        let mut raw: Vec<Option<(u32, Vec<u8>)>> = Vec::with_capacity(message_ids.len());
        for &message_id in message_ids {
            let Some(packed) = self.msg_index.get_packed(chat_id, message_id) else {
                raw.push(None);
                continue;
            };
            let (page_id, slot) = unpack_loc(packed);
            let page = self.pool.peek(&mut self.heap, page_id)?;
            match page.get_tuple(slot) {
                Some(tuple) => raw.push(Some((message_id, tuple))),
                None => raw.push(None),
            }
        }
        use rayon::prelude::*;
        let out = raw
            .into_par_iter()
            .map(|item| {
                let Some((want_id, bytes)) = item else {
                    return None;
                };
                match decode_chat_tuple(&bytes) {
                    Ok(t) if t.message_id == want_id => Some(t),
                    _ => None,
                }
            })
            .collect();
        Ok(out)
    }

    pub fn chat_trim_keep_last(&mut self, chat_id: i64, keep: usize) -> Result<()> {
        self.ensure_open()?;
        let mut payload = Vec::with_capacity(12);
        payload.extend_from_slice(&chat_id.to_le_bytes());
        payload.extend_from_slice(&(keep as u32).to_le_bytes());
        let lsn = self.log(WalType::TrimChat, &payload)?;
        self.trim_chat_local(chat_id, keep)?;
        self.lsn = self.lsn.max(lsn + 1);
        Ok(())
    }

    fn trim_chat_local(&mut self, chat_id: i64, keep: usize) -> Result<()> {
        let Some(tip) = self.chat_tips.get(&chat_id).copied() else {
            return Ok(());
        };
        if tip.count as usize <= keep {
            return Ok(());
        }
        let all = self.read_chat_chain(tip)?;
        let kept = all[all.len().saturating_sub(keep)..].to_vec();
        let mut old = Vec::new();
        let mut page_id = tip.head;
        let mut seen = HashSet::new();
        while page_id != 0 && seen.insert(page_id) {
            old.push(page_id);
            page_id = self.pool.peek(&mut self.heap, page_id)?.next_page_id();
        }
        self.msg_index.delete_chat(chat_id);
        for page_id in old {
            self.free_page(page_id)?;
        }
        if kept.is_empty() {
            self.chat_tips.remove(&chat_id);
            self.chat_recent_ring.remove(&chat_id);
            return Ok(());
        }
        let head = self.alloc_page(PageType::Chat)?;
        let mut tail = head;
        self.pool
            .get(&mut self.heap, head)?
            .page
            .write_i64_at(32, chat_id);
        self.pool.unpin(head, true);
        let mut count = 0;
        for item in &kept {
            let bytes = encode_chat_tuple(item)?;
            let mut slot = {
                let frame = self.pool.get(&mut self.heap, tail)?;
                let slot = frame.page.insert(&bytes);
                self.pool.unpin(tail, slot.is_some());
                slot
            };
            if slot.is_none() {
                let next = self.alloc_page(PageType::Chat)?;
                self.pool
                    .get(&mut self.heap, next)?
                    .page
                    .write_i64_at(32, chat_id);
                self.pool.unpin(next, true);
                self.pool.get(&mut self.heap, tail)?.page.set_next(next);
                self.pool.unpin(tail, true);
                tail = next;
                let frame = self.pool.get(&mut self.heap, tail)?;
                slot = frame.page.insert(&bytes);
                self.pool.unpin(tail, slot.is_some());
            }
            let slot = slot.ok_or_else(|| NyatError::Msg("chat tuple too large".into()))?;
            self.msg_index.set(chat_id, item.message_id, tail, slot);
            count += 1;
        }
        self.chat_tips
            .insert(chat_id, ChatTip { head, tail, count });
        let start = kept.len().saturating_sub(self.chat_ring_max as usize);
        self.chat_recent_ring
            .insert(chat_id, kept[start..].to_vec());
        Ok(())
    }

    pub fn hot_set(&mut self, key: &str, value: &[u8], ttl_ms: u64) -> Result<()> {
        self.ensure_open()?;
        let expires_at = if ttl_ms == 0 {
            0
        } else {
            Self::now_ms().saturating_add(ttl_ms)
        };
        let payload = encode_hot(key, value, expires_at);
        let lsn = self.log(WalType::SetHot, &payload)?;
        self.apply_wal(WalType::SetHot, &payload, lsn)
    }

    pub fn hot_get(&mut self, key: &str) -> Result<Option<Vec<u8>>> {
        self.ensure_open()?;
        let start_page_id = *self.hot_index.get(key).unwrap_or(&self.hot_page_id);
        // Walk the page chain — the key may be on an overflow page.
        let mut page_id = start_page_id;
        loop {
            let frame = self.pool.get(&mut self.heap, page_id)?;
            let mut next = 0;
            for tuple in frame.page.all_tuples() {
                let (candidate, value, expires_at) = decode_hot(&tuple)?;
                if candidate == key {
                    self.pool.unpin(page_id, false);
                    return Ok((expires_at == 0 || expires_at > Self::now_ms()).then_some(value));
                }
            }
            next = frame.page.next_page_id();
            self.pool.unpin(page_id, false);
            if next == 0 {
                break;
            }
            page_id = next;
        }
        Ok(None)
    }

    pub fn hot_del(&mut self, key: &str) -> Result<()> {
        self.ensure_open()?;
        let lsn = self.log(WalType::DelHot, key.as_bytes())?;
        self.apply_wal(WalType::DelHot, key.as_bytes(), lsn)
    }

    pub fn impulse_schedule(&mut self, job: ImpulseTuple) -> Result<()> {
        self.ensure_open()?;
        let payload = encode_impulse(&job);
        let lsn = self.log(WalType::EnqueueImpulse, &payload)?;
        self.apply_wal(WalType::EnqueueImpulse, &payload, lsn)
    }

    pub fn impulse_due(&mut self, now: u64, limit: usize) -> Result<Vec<ImpulseTuple>> {
        self.ensure_open()?;
        let mut page_id = self.impulse_page_id;
        let mut seen = HashSet::new();
        let mut out = Vec::new();
        while page_id != 0 && seen.insert(page_id) && out.len() < limit {
            let page = self.pool.peek(&mut self.heap, page_id)?;
            let next = page.next_page_id();
            for tuple in page.all_tuples() {
                let item = decode_impulse(&tuple)?;
                if item.run_at <= now {
                    out.push(item);
                }
            }
            page_id = next;
        }
        out.sort_by_key(|item| item.run_at);
        out.truncate(limit);
        Ok(out)
    }

    pub fn impulse_ack(&mut self, id: &str) -> Result<()> {
        self.ensure_open()?;
        let lsn = self.log(WalType::AckImpulse, id.as_bytes())?;
        self.apply_wal(WalType::AckImpulse, id.as_bytes(), lsn)
    }

    pub fn bond_upsert(&mut self, bond: BondTuple) -> Result<()> {
        self.ensure_open()?;
        let payload = encode_bond(&bond);
        let lsn = self.log(WalType::UpsertBond, &payload)?;
        self.apply_wal(WalType::UpsertBond, &payload, lsn)
    }

    pub fn bond_list(&mut self, limit: usize) -> Result<Vec<BondTuple>> {
        self.ensure_open()?;
        let mut page_id = self.bond_page_id;
        let mut seen = HashSet::new();
        let mut out = Vec::new();
        while page_id != 0 && seen.insert(page_id) && out.len() < limit {
            let page = self.pool.peek(&mut self.heap, page_id)?;
            let next = page.next_page_id();
            for tuple in page.all_tuples() {
                out.push(decode_bond(&tuple)?);
            }
            page_id = next;
        }
        out.truncate(limit);
        Ok(out)
    }

    pub fn recall_upsert(&mut self, rec: RecallRec) -> Result<()> {
        self.ensure_open()?;
        let payload = encode_recall(&rec)?;
        let lsn = self.log(WalType::UpsertRecall, &payload)?;
        self.apply_wal(WalType::UpsertRecall, &payload, lsn)
    }

    pub fn recall_search(
        &self,
        query: &[f32],
        chat_id: Option<i64>,
        top_k: usize,
        min_visibility: u8,
    ) -> Vec<(i64, u32, f32)> {
        let mut out: Vec<_> = self
            .recall_mem
            .iter()
            .filter(|rec| rec.visibility >= min_visibility)
            .filter(|rec| chat_id.is_none_or(|id| rec.chat_id == id))
            .map(|rec| (rec.chat_id, rec.message_id, cosine(query, &rec.vector)))
            .collect();
        out.sort_by(|a, b| b.2.total_cmp(&a.2));
        out.truncate(top_k);
        out
    }

    fn persist_meta(&self) -> Result<()> {
        let meta = EngineMeta {
            schema: SCHEMA_VERSION,
            lsn: self.lsn.to_string(),
            checkpoint_lsn: self.checkpoint_lsn.to_string(),
        };
        let tmp = self.path.join("ENGINE.json.tmp");
        fs::write(&tmp, serde_json::to_string_pretty(&meta).unwrap())?;
        fs::rename(tmp, self.path.join("ENGINE.json"))?;
        Ok(())
    }

    pub fn checkpoint(&mut self) -> Result<()> {
        self.ensure_open()?;
        self.pool.flush_all(&mut self.heap)?;
        self.heap.sync()?;
        let lsn = self.log(WalType::Checkpoint, &[])?;
        self.wal.sync()?;
        self.checkpoint_lsn = lsn + 1;
        save_msg_index(&self.path, &self.msg_index, self.checkpoint_lsn)?;
        self.persist_meta()?;
        self.wal.rotate()
    }

    pub fn verify(&mut self) -> Result<u32> {
        self.ensure_open()?;
        let pages = self.heap.size_pages();
        for id in 0..pages {
            self.heap.read_page(id, true)?;
        }
        Ok(pages)
    }

    pub fn stats(&self) -> EngineStats {
        EngineStats {
            pages: self.heap.size_pages(),
            chats: self.chat_tips.len() as u32,
            recalls: self.recall_mem.len() as u32,
            indexed: self.msg_index.size() as u32,
            lsn: self.lsn,
            pool: self.pool.stats(),
        }
    }

    pub fn pages(&self) -> u32 {
        self.heap.size_pages()
    }

    pub fn pool_stats(&self) -> (usize, usize) {
        self.pool.stats()
    }

    /// Compatibility wrappers for the Step 2 native smoke interface.
    pub fn storage_smoke_write(&mut self, payload: &[u8]) -> Result<(u32, u16)> {
        let message_id = self.msg_index.size() as u32 + 1;
        self.chat_append(
            0,
            message_id,
            Self::now_ms(),
            0,
            2,
            String::from_utf8_lossy(payload).into_owned(),
            false,
        )?;
        let (page_id, slot) = unpack_loc(self.msg_index.get_packed(0, message_id).unwrap());
        Ok((page_id, slot))
    }

    pub fn storage_smoke_read(&mut self, page_id: u32, slot: u16) -> Result<Vec<u8>> {
        self.ensure_open()?;
        let tuple = self
            .pool
            .peek(&mut self.heap, page_id)?
            .get_tuple(slot)
            .ok_or_else(|| NyatError::Msg("missing tuple".into()))?;
        Ok(decode_chat_tuple(&tuple)
            .map(|item| item.text.into_bytes())
            .unwrap_or(tuple))
    }

    pub fn close(&mut self, skip_checkpoint: bool) -> Result<()> {
        if self.closed {
            return Ok(());
        }
        if skip_checkpoint {
            self.pool.flush_all(&mut self.heap)?;
            self.heap.sync()?;
            self.wal.sync()?;
        } else {
            self.checkpoint()?;
        }
        self.closed = true;
        Ok(())
    }

    /// Test-only crash simulation: durability ends at the WAL, not the buffer pool.
    pub fn crash_without_flush_for_test(&mut self) -> Result<()> {
        self.ensure_open()?;
        self.wal.sync()?;
        self.closed = true;
        Ok(())
    }

    fn ensure_open(&self) -> Result<()> {
        if self.closed {
            Err(NyatError::Closed)
        } else {
            Ok(())
        }
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        if !self.closed {
            let _ = self.pool.flush_all(&mut self.heap);
            let _ = self.heap.sync();
            let _ = self.wal.sync();
            self.closed = true;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn opts(path: PathBuf) -> OpenOpts {
        OpenOpts {
            path,
            sync_every: 1,
            pool_frames: 32,
            chat_ring_max: 50,
            verify_on_open: false,
        }
    }

    #[test]
    fn chat_get_recent_hot_roundtrip() {
        let dir = tempdir().unwrap();
        let mut engine = Engine::open(opts(dir.path().to_path_buf())).unwrap();
        engine
            .chat_append(-100, 7, 123, 9, 0, "hello".into(), false)
            .unwrap();
        engine
            .chat_append(-100, 8, 124, 9, 1, "world".into(), false)
            .unwrap();
        assert_eq!(engine.chat_get(-100, 7).unwrap().unwrap().text, "hello");
        let batch = engine.chat_get_batch(-100, &[7, 8, 99]).unwrap();
        assert_eq!(batch[0].as_ref().unwrap().text, "hello");
        assert_eq!(batch[1].as_ref().unwrap().text, "world");
        assert!(batch[2].is_none());
        assert_eq!(engine.chat_recent(-100, 1).unwrap()[0].message_id, 8);
        engine.hot_set("key", b"value", 0).unwrap();
        assert_eq!(engine.hot_get("key").unwrap(), Some(b"value".to_vec()));
    }

    #[test]
    fn wal_replay_after_crash() {
        let dir = tempdir().unwrap();
        {
            let mut engine = Engine::open(opts(dir.path().to_path_buf())).unwrap();
            engine
                .chat_append(-100, 7, 123, 9, 0, "recover me".into(), false)
                .unwrap();
            engine.crash_without_flush_for_test().unwrap();
        }
        let mut recovered = Engine::open(opts(dir.path().to_path_buf())).unwrap();
        assert_eq!(
            recovered.chat_get(-100, 7).unwrap().unwrap().text,
            "recover me"
        );
    }

    #[test]
    fn double_close_ok() {
        let dir = tempdir().unwrap();
        let mut engine = Engine::open(opts(dir.path().to_path_buf())).unwrap();
        engine.close(true).unwrap();
        engine.close(true).unwrap();
    }

    #[test]
    fn drop_does_not_panic() {
        let dir = tempdir().unwrap();
        let engine = Engine::open(opts(dir.path().to_path_buf())).unwrap();
        drop(engine);
    }
}

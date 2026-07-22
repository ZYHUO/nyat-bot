//! Compact secondary index + snap/msg.idx persistence.

use std::collections::HashMap;
use std::fs;
use std::path::Path;

use crate::error::{NyatError, Result};

const MAGIC: &[u8; 4] = b"NIDX";
const SLOT_MASK: u32 = 0xffff;

pub fn pack_loc(page_id: u32, slot: u16) -> u64 {
    (page_id as u64) * 0x10000 + (slot as u64 & SLOT_MASK as u64)
}

pub fn unpack_loc(packed: u64) -> (u32, u16) {
    (
        (packed / 0x10000) as u32,
        (packed & SLOT_MASK as u64) as u16,
    )
}

#[derive(Default, Clone)]
pub struct CompactMsgIndex {
    by_chat: HashMap<i64, HashMap<u32, u64>>,
    size: usize,
}

impl CompactMsgIndex {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn size(&self) -> usize {
        self.size
    }

    pub fn clear(&mut self) {
        self.by_chat.clear();
        self.size = 0;
    }

    pub fn set(&mut self, chat_id: i64, message_id: u32, page_id: u32, slot: u16) {
        let m = self.by_chat.entry(chat_id).or_default();
        if !m.contains_key(&message_id) {
            self.size += 1;
        }
        m.insert(message_id, pack_loc(page_id, slot));
    }

    pub fn get_packed(&self, chat_id: i64, message_id: u32) -> Option<u64> {
        self.by_chat.get(&chat_id)?.get(&message_id).copied()
    }

    pub fn delete_chat(&mut self, chat_id: i64) {
        if let Some(m) = self.by_chat.remove(&chat_id) {
            self.size -= m.len();
        }
    }

    pub fn for_each<F: FnMut(i64, u32, u32, u16)>(&self, mut f: F) {
        for (&chat_id, m) in &self.by_chat {
            for (&message_id, &packed) in m {
                let (page_id, slot) = unpack_loc(packed);
                f(chat_id, message_id, page_id, slot);
            }
        }
    }
}

pub fn save_msg_index(dir: &Path, index: &CompactMsgIndex, checkpoint_lsn: u64) -> Result<()> {
    let snap = dir.join("snap");
    fs::create_dir_all(&snap)?;
    let n = index.size();
    let mut body = vec![0u8; 4 + 8 + 4 + n * 18];
    body[0..4].copy_from_slice(MAGIC);
    body[4..12].copy_from_slice(&checkpoint_lsn.to_le_bytes());
    body[12..16].copy_from_slice(&(n as u32).to_le_bytes());
    let mut o = 16;
    index.for_each(|chat_id, message_id, page_id, slot| {
        body[o..o + 8].copy_from_slice(&chat_id.to_le_bytes());
        o += 8;
        body[o..o + 4].copy_from_slice(&message_id.to_le_bytes());
        o += 4;
        body[o..o + 4].copy_from_slice(&page_id.to_le_bytes());
        o += 4;
        body[o..o + 2].copy_from_slice(&slot.to_le_bytes());
        o += 2;
    });
    let z = zstd::encode_all(&body[..], 0).map_err(|e| NyatError::Msg(format!("zstd: {e}")))?;
    let mut out = Vec::with_capacity(1 + z.len());
    out.push(1);
    out.extend_from_slice(&z);
    let path = snap.join("msg.idx");
    let tmp = snap.join("msg.idx.tmp");
    fs::write(&tmp, &out)?;
    fs::rename(&tmp, &path)?;
    Ok(())
}

pub fn load_msg_index(dir: &Path, expect_lsn: u64) -> Result<Option<CompactMsgIndex>> {
    let path = dir.join("snap").join("msg.idx");
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read(&path)?;
    if raw.is_empty() {
        return Ok(None);
    }
    let body = if raw[0] == 1 {
        zstd::decode_all(&raw[1..]).map_err(|e| NyatError::Msg(format!("zstd: {e}")))?
    } else {
        raw[1..].to_vec()
    };
    if body.len() < 16 || &body[0..4] != MAGIC {
        return Ok(None);
    }
    let lsn = u64::from_le_bytes(body[4..12].try_into().unwrap());
    if lsn != expect_lsn {
        return Ok(None);
    }
    let n = u32::from_le_bytes(body[12..16].try_into().unwrap()) as usize;
    let mut map = CompactMsgIndex::new();
    let mut o = 16;
    for _ in 0..n {
        if o + 18 > body.len() {
            break;
        }
        let chat_id = i64::from_le_bytes(body[o..o + 8].try_into().unwrap());
        o += 8;
        let message_id = u32::from_le_bytes(body[o..o + 4].try_into().unwrap());
        o += 4;
        let page_id = u32::from_le_bytes(body[o..o + 4].try_into().unwrap());
        o += 4;
        let slot = u16::from_le_bytes(body[o..o + 2].try_into().unwrap());
        o += 2;
        map.set(chat_id, message_id, page_id, slot);
    }
    Ok(Some(map))
}

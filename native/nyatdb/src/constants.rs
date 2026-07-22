//! On-disk constants — must match `src/nyatdb/format/constants.ts`.

#![allow(dead_code)] // full enum surface used as domain grows (Step 3+)

pub const PAGE_SIZE: usize = 4096;
pub const PAGE_MAGIC: [u8; 4] = *b"NYP1";
pub const WAL_MAGIC: [u8; 4] = *b"NW1\0";
pub const SCHEMA_VERSION: u32 = 3;
pub const PAGE_HEADER_SIZE: usize = 64;

#[repr(u8)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PageType {
  Free = 0,
  Super = 1,
  Chat = 2,
  Hot = 3,
  Impulse = 4,
  Bond = 5,
  Recall = 6,
  Catalog = 7,
}

impl PageType {
  pub fn from_u8(v: u8) -> Option<Self> {
    Some(match v {
      0 => Self::Free,
      1 => Self::Super,
      2 => Self::Chat,
      3 => Self::Hot,
      4 => Self::Impulse,
      5 => Self::Bond,
      6 => Self::Recall,
      7 => Self::Catalog,
      _ => return None,
    })
  }
}

#[repr(u8)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WalType {
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

impl WalType {
  pub fn from_u8(v: u8) -> Option<Self> {
    Some(match v {
      1 => Self::AllocPage,
      2 => Self::InsertTuple,
      3 => Self::SetHot,
      4 => Self::EnqueueImpulse,
      5 => Self::AckImpulse,
      6 => Self::UpsertBond,
      7 => Self::UpsertRecall,
      8 => Self::Checkpoint,
      9 => Self::LinkChatPage,
      10 => Self::DelHot,
      11 => Self::TrimChat,
      _ => return None,
    })
  }
}

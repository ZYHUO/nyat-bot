//! Slotted 4KB page — layout identical to `src/nyatdb/format/page.ts`.

use crate::constants::{PAGE_HEADER_SIZE, PAGE_MAGIC, PAGE_SIZE, PageType};
use crate::crc32::crc32;

#[derive(Clone)]
pub struct Page {
  pub buf: [u8; PAGE_SIZE],
}

impl Page {
  pub fn new_empty() -> Self {
    let mut buf = [0u8; PAGE_SIZE];
    buf[0..4].copy_from_slice(&PAGE_MAGIC);
    Self::write_u16(&mut buf, 20, PAGE_HEADER_SIZE as u16);
    Self::write_u16(&mut buf, 22, PAGE_SIZE as u16);
    Self { buf }
  }

  pub fn from_buf(buf: [u8; PAGE_SIZE]) -> Self {
    Self { buf }
  }

  pub fn alloc(page_id: u32, ty: PageType) -> Self {
    let mut p = Self::new_empty();
    p.set_page_id(page_id);
    p.set_type(ty);
    p.set_lsn(0);
    p.set_next(0);
    p.recompute_crc();
    p
  }

  fn write_u16(buf: &mut [u8], off: usize, v: u16) {
    buf[off..off + 2].copy_from_slice(&v.to_le_bytes());
  }
  fn read_u16(buf: &[u8], off: usize) -> u16 {
    u16::from_le_bytes([buf[off], buf[off + 1]])
  }
  fn write_u32(buf: &mut [u8], off: usize, v: u32) {
    buf[off..off + 4].copy_from_slice(&v.to_le_bytes());
  }
  fn read_u32(buf: &[u8], off: usize) -> u32 {
    u32::from_le_bytes([buf[off], buf[off + 1], buf[off + 2], buf[off + 3]])
  }
  fn write_u64(buf: &mut [u8], off: usize, v: u64) {
    buf[off..off + 8].copy_from_slice(&v.to_le_bytes());
  }
  fn read_u64(buf: &[u8], off: usize) -> u64 {
    u64::from_le_bytes(buf[off..off + 8].try_into().unwrap())
  }

  pub fn page_type(&self) -> PageType {
    PageType::from_u8(self.buf[4]).unwrap_or(PageType::Free)
  }
  pub fn set_type(&mut self, t: PageType) {
    self.buf[4] = t as u8;
  }

  pub fn page_id(&self) -> u32 {
    Self::read_u32(&self.buf, 6)
  }
  pub fn set_page_id(&mut self, id: u32) {
    Self::write_u32(&mut self.buf, 6, id);
  }

  pub fn lsn(&self) -> u64 {
    Self::read_u64(&self.buf, 10)
  }
  pub fn set_lsn(&mut self, lsn: u64) {
    Self::write_u64(&mut self.buf, 10, lsn);
  }

  pub fn nslots(&self) -> u16 {
    Self::read_u16(&self.buf, 18)
  }
  fn set_nslots(&mut self, n: u16) {
    Self::write_u16(&mut self.buf, 18, n);
  }

  pub fn lower(&self) -> u16 {
    Self::read_u16(&self.buf, 20)
  }
  fn set_lower(&mut self, v: u16) {
    Self::write_u16(&mut self.buf, 20, v);
  }

  pub fn upper(&self) -> u16 {
    Self::read_u16(&self.buf, 22)
  }
  fn set_upper(&mut self, v: u16) {
    Self::write_u16(&mut self.buf, 22, v);
  }

  pub fn next_page_id(&self) -> u32 {
    Self::read_u32(&self.buf, 28)
  }
  pub fn set_next(&mut self, id: u32) {
    Self::write_u32(&mut self.buf, 28, id);
  }

  pub fn free_space(&self) -> i32 {
    self.upper() as i32 - self.lower() as i32 - 4
  }

  /// Insert tuple; returns slot index or None if full.
  pub fn insert(&mut self, tuple: &[u8]) -> Option<u16> {
    let need = tuple.len() + 4;
    if self.free_space() < tuple.len() as i32 {
      return None;
    }
    if (self.upper() as usize).saturating_sub(self.lower() as usize) < need {
      return None;
    }
    let off = self.lower() as usize;
    self.buf[off..off + tuple.len()].copy_from_slice(tuple);
    let new_lower = off + tuple.len();
    let new_upper = self.upper() as usize - 4;
    Self::write_u16(&mut self.buf, new_upper, off as u16);
    Self::write_u16(&mut self.buf, new_upper + 2, tuple.len() as u16);
    self.set_lower(new_lower as u16);
    self.set_upper(new_upper as u16);
    let slot = self.nslots();
    self.set_nslots(slot + 1);
    Some(slot)
  }

  pub fn tuple_range(&self, slot: u16) -> Option<(usize, usize)> {
    if slot >= self.nslots() {
      return None;
    }
    let dir = PAGE_SIZE - (slot as usize + 1) * 4;
    let off = Self::read_u16(&self.buf, dir) as usize;
    let len = Self::read_u16(&self.buf, dir + 2) as usize;
    if off < PAGE_HEADER_SIZE || off + len > self.lower() as usize {
      return None;
    }
    Some((off, len))
  }

  pub fn get_tuple(&self, slot: u16) -> Option<Vec<u8>> {
    let (off, len) = self.tuple_range(slot)?;
    Some(self.buf[off..off + len].to_vec())
  }

  pub fn all_tuples(&self) -> Vec<Vec<u8>> {
    let mut out = Vec::new();
    for s in 0..self.nslots() {
      if let Some(t) = self.get_tuple(s) {
        out.push(t);
      }
    }
    out
  }

  pub fn write_i64_at(&mut self, off: usize, v: i64) {
    self.buf[off..off + 8].copy_from_slice(&v.to_le_bytes());
  }

  pub fn read_i64_at(&self, off: usize) -> i64 {
    i64::from_le_bytes(self.buf[off..off + 8].try_into().unwrap())
  }

  pub fn write_u32_at(&mut self, off: usize, v: u32) {
    Self::write_u32(&mut self.buf, off, v);
  }

  pub fn read_u32_at(&self, off: usize) -> u32 {
    Self::read_u32(&self.buf, off)
  }

  pub fn copy_from(&mut self, other: &Page) {
    self.buf = other.buf;
  }

  pub fn verify_magic(&self) -> bool {
    self.buf[0..4] == PAGE_MAGIC
  }

  pub fn recompute_crc(&mut self) {
    Self::write_u32(&mut self.buf, 24, 0);
    let c = crc32(&self.buf);
    Self::write_u32(&mut self.buf, 24, c);
  }

  pub fn check_crc(&mut self) -> bool {
    let stored = Self::read_u32(&self.buf, 24);
    Self::write_u32(&mut self.buf, 24, 0);
    let c = crc32(&self.buf);
    Self::write_u32(&mut self.buf, 24, stored);
    c == stored
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn insert_roundtrip_crc() {
    let mut p = Page::alloc(3, PageType::Chat);
    assert_eq!(p.insert(b"hello"), Some(0));
    assert_eq!(p.insert(b"world!!"), Some(1));
    assert_eq!(p.get_tuple(0).as_deref(), Some(&b"hello"[..]));
    p.recompute_crc();
    assert!(p.check_crc());
    assert_eq!(p.buf.len(), PAGE_SIZE);
  }
}

//! Fixed-size buffer pool with clock eviction.

use std::collections::HashMap;

use crate::error::Result;
use crate::heap::HeapFile;
use crate::page::Page;

pub struct Frame {
  pub page: Page,
  pub dirty: bool,
  pub pin: u32,
  pub ref_bit: bool,
}

pub struct BufferPool {
  frames: HashMap<u32, Frame>,
  max_frames: usize,
  clock_key: usize,
}

impl BufferPool {
  pub fn new(max_frames: usize) -> Self {
    Self {
      frames: HashMap::new(),
      max_frames: max_frames.max(8),
      clock_key: 0,
    }
  }

  pub fn get(&mut self, heap: &mut HeapFile, page_id: u32) -> Result<&mut Frame> {
    if self.frames.contains_key(&page_id) {
      let f = self.frames.get_mut(&page_id).unwrap();
      f.ref_bit = true;
      f.pin += 1;
      return Ok(f);
    }
    self.evict_if_needed(heap)?;
    let page = heap.read_page(page_id, false)?;
    self.frames.insert(
      page_id,
      Frame {
        page,
        dirty: false,
        pin: 1,
        ref_bit: true,
      },
    );
    Ok(self.frames.get_mut(&page_id).unwrap())
  }

  pub fn peek(&mut self, heap: &mut HeapFile, page_id: u32) -> Result<&Page> {
    if self.frames.contains_key(&page_id) {
      let f = self.frames.get_mut(&page_id).unwrap();
      f.ref_bit = true;
      return Ok(&self.frames.get(&page_id).unwrap().page);
    }
    self.evict_if_needed(heap)?;
    let page = heap.read_page(page_id, false)?;
    self.frames.insert(
      page_id,
      Frame {
        page,
        dirty: false,
        pin: 0,
        ref_bit: true,
      },
    );
    Ok(&self.frames.get(&page_id).unwrap().page)
  }

  pub fn unpin(&mut self, page_id: u32, dirty: bool) {
    if let Some(f) = self.frames.get_mut(&page_id) {
      if dirty {
        f.dirty = true;
      }
      f.pin = f.pin.saturating_sub(1);
    }
  }

  pub fn flush_all(&mut self, heap: &mut HeapFile) -> Result<()> {
    let ids: Vec<u32> = self
      .frames
      .iter()
      .filter(|(_, f)| f.dirty)
      .map(|(id, _)| *id)
      .collect();
    for id in ids {
      if let Some(f) = self.frames.get_mut(&id) {
        heap.write_page(id, &mut f.page)?;
        f.dirty = false;
      }
    }
    Ok(())
  }

  fn evict_if_needed(&mut self, heap: &mut HeapFile) -> Result<()> {
    while self.frames.len() >= self.max_frames {
      let keys: Vec<u32> = self.frames.keys().copied().collect();
      if keys.is_empty() {
        return Ok(());
      }
      let mut victim: Option<u32> = None;
      for _ in 0..keys.len() * 2 {
        self.clock_key = (self.clock_key + 1) % keys.len();
        let id = keys[self.clock_key];
        let f = self.frames.get_mut(&id).unwrap();
        if f.pin > 0 {
          continue;
        }
        if f.ref_bit {
          f.ref_bit = false;
          continue;
        }
        victim = Some(id);
        break;
      }
      let Some(victim) = victim else {
        return Ok(());
      };
      if let Some(mut f) = self.frames.remove(&victim) {
        if f.dirty {
          heap.write_page(victim, &mut f.page)?;
        }
      }
    }
    Ok(())
  }

  pub fn stats(&self) -> (usize, usize) {
    let dirty = self.frames.values().filter(|f| f.dirty).count();
    (self.frames.len(), dirty)
  }
}

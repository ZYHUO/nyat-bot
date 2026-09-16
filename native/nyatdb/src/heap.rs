//! Single-file page heap: pageId * PAGE_SIZE → bytes.

use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use crate::constants::{PAGE_SIZE, PageType};
use crate::error::{NyatError, Result};
use crate::page::Page;

pub struct HeapFile {
  pub path: PathBuf,
  file: File,
  page_count: u32,
}

impl HeapFile {
  pub fn open(dir: &Path) -> Result<Self> {
    std::fs::create_dir_all(dir)?;
    let path = dir.join("heap.ndb");
    let exists = path.exists();
    let mut file = OpenOptions::new()
      .read(true)
      .write(true)
      .create(true)
      .truncate(false)
      .open(&path)?;
    let size = file.metadata()?.len() as usize;
    let mut page_count = (size / PAGE_SIZE) as u32;
    if page_count == 0 {
      let mut super_page = Page::alloc(0, PageType::Super);
      super_page.recompute_crc();
      file.seek(SeekFrom::Start(0))?;
      file.write_all(&super_page.buf)?;
      file.sync_all()?;
      page_count = 1;
    } else if !exists {
      // created empty then sized — already handled
    }
    Ok(Self {
      path,
      file,
      page_count,
    })
  }

  pub fn size_pages(&self) -> u32 {
    self.page_count
  }

  pub fn read_page(&mut self, page_id: u32, check_crc: bool) -> Result<Page> {
    if page_id >= self.page_count {
      return Err(NyatError::BadPageId(page_id));
    }
    let mut buf = [0u8; PAGE_SIZE];
    self.file
      .seek(SeekFrom::Start(page_id as u64 * PAGE_SIZE as u64))?;
    self.file.read_exact(&mut buf)?;
    let mut page = Page::from_buf(buf);
    if !page.verify_magic() {
      return Err(NyatError::BadMagic(page_id));
    }
    if check_crc && !page.check_crc() {
      return Err(NyatError::CrcFail(page_id));
    }
    Ok(page)
  }

  pub fn write_page(&mut self, page_id: u32, page: &mut Page) -> Result<()> {
    page.recompute_crc();
    self.file
      .seek(SeekFrom::Start(page_id as u64 * PAGE_SIZE as u64))?;
    self.file.write_all(&page.buf)?;
    Ok(())
  }

  pub fn append_page(&mut self, page: &mut Page) -> Result<u32> {
    let id = self.page_count;
    page.set_page_id(id);
    page.recompute_crc();
    self.file
      .seek(SeekFrom::Start(id as u64 * PAGE_SIZE as u64))?;
    self.file.write_all(&page.buf)?;
    self.page_count += 1;
    Ok(id)
  }

  pub fn ensure_page_count(&mut self, n: u32) -> Result<()> {
    while self.page_count < n {
      let mut p = Page::alloc(self.page_count, PageType::Free);
      self.append_page(&mut p)?;
    }
    Ok(())
  }

  pub fn sync(&mut self) -> Result<()> {
    self.file.sync_all()?;
    Ok(())
  }

  pub fn close(mut self) -> Result<()> {
    self.file.sync_all()?;
    Ok(())
  }
}

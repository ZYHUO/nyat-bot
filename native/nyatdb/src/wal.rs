//! Binary redo WAL.
//! Frame: magic(4) | lsn u64 | type u8 | len u32 | payload | crc32

use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::constants::{WAL_MAGIC, WalType};
use crate::crc32::crc32;
use crate::error::Result;

pub struct WalRecord {
  pub lsn: u64,
  pub ty: WalType,
  pub payload: Vec<u8>,
}

pub struct RedoWal {
  pub path: PathBuf,
  dir: PathBuf,
  file: File,
  lsn: u64,
}

impl RedoWal {
  pub fn open(dir: &Path, start_lsn: u64) -> Result<Self> {
    std::fs::create_dir_all(dir)?;
    let path = dir.join("redo.wal");
    let file = OpenOptions::new()
      .create(true)
      .append(true)
      .read(true)
      .open(&path)?;
    Ok(Self {
      path,
      dir: dir.to_path_buf(),
      file,
      lsn: start_lsn,
    })
  }

  pub fn next_lsn(&self) -> u64 {
    self.lsn
  }

  pub fn append(&mut self, ty: WalType, payload: &[u8]) -> Result<u64> {
    let lsn = self.lsn;
    self.lsn = lsn + 1;
    let mut header = Vec::with_capacity(17);
    header.extend_from_slice(&WAL_MAGIC);
    header.extend_from_slice(&lsn.to_le_bytes());
    header.push(ty as u8);
    header.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    let mut for_crc = Vec::with_capacity(header.len() + payload.len());
    for_crc.extend_from_slice(&header);
    for_crc.extend_from_slice(payload);
    let c = crc32(&for_crc);
    self.file.write_all(&header)?;
    self.file.write_all(payload)?;
    self.file.write_all(&c.to_le_bytes())?;
    Ok(lsn)
  }

  pub fn sync(&mut self) -> Result<()> {
    self.file.sync_all()?;
    Ok(())
  }

  pub fn close(mut self) -> Result<()> {
    self.file.sync_all()?;
    Ok(())
  }

  /// After checkpoint: drop old frames, start a fresh WAL at current LSN.
  pub fn rotate(&mut self) -> Result<()> {
    self.sync()?;
    // Drop the old File handle by replacing it.
    let bak = self.dir.join(format!(
      "redo-{}.wal.bak",
      SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
    ));
    // Close by reopening — std::fs::rename while File is open is OK on Linux.
    let _ = std::fs::rename(&self.path, &bak);
    self.file = OpenOptions::new()
      .create(true)
      .write(true)
      .truncate(true)
      .open(&self.path)?;
    let _ = std::fs::remove_file(&bak);
    Ok(())
  }

  pub fn replay(path: &Path) -> Result<Vec<WalRecord>> {
    if !path.exists() {
      return Ok(vec![]);
    }
    let mut buf = Vec::new();
    File::open(path)?.read_to_end(&mut buf)?;
    let mut out = Vec::new();
    let mut i = 0usize;
    while i + 17 <= buf.len() {
      if buf[i..i + 4] != WAL_MAGIC {
        break;
      }
      let start = i;
      let lsn = u64::from_le_bytes(buf[i + 4..i + 12].try_into().unwrap());
      let ty = match WalType::from_u8(buf[i + 12]) {
        Some(t) => t,
        None => break,
      };
      let len = u32::from_le_bytes(buf[i + 13..i + 17].try_into().unwrap()) as usize;
      i += 17;
      if i + len + 4 > buf.len() {
        break;
      }
      let payload = buf[i..i + len].to_vec();
      i += len;
      let want = u32::from_le_bytes(buf[i..i + 4].try_into().unwrap());
      i += 4;
      let got = crc32(&buf[start..i - 4]);
      if want != got {
        break;
      }
      out.push(WalRecord { lsn, ty, payload });
    }
    Ok(out)
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use tempfile::tempdir;

  #[test]
  fn append_replay() {
    let dir = tempdir().unwrap();
    let wal_dir = dir.path().join("wal");
    {
      let mut w = RedoWal::open(&wal_dir, 1).unwrap();
      w.append(WalType::Checkpoint, b"").unwrap();
      w.append(WalType::SetHot, b"k\0v").unwrap();
      w.sync().unwrap();
    }
    let recs = RedoWal::replay(&wal_dir.join("redo.wal")).unwrap();
    assert_eq!(recs.len(), 2);
    assert_eq!(recs[0].lsn, 1);
    assert_eq!(recs[1].payload, b"k\0v");
  }
}

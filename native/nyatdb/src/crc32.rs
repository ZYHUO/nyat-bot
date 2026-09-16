//! IEEE CRC-32 (polynomial 0xEDB88320) — must match `src/nyatdb/format/crc32.ts`.

const TABLE: [u32; 256] = {
  let mut t = [0u32; 256];
  let mut i = 0u32;
  while i < 256 {
    let mut c = i;
    let mut k = 0;
    while k < 8 {
      c = if c & 1 != 0 {
        0xedb88320 ^ (c >> 1)
      } else {
        c >> 1
      };
      k += 1;
    }
    t[i as usize] = c;
    i += 1;
  }
  t
};

pub fn crc32(data: &[u8]) -> u32 {
  let mut c: u32 = 0xffff_ffff;
  for &b in data {
    c = TABLE[((c ^ u32::from(b)) & 0xff) as usize] ^ (c >> 8);
  }
  c ^ 0xffff_ffff
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn empty_and_known() {
    assert_eq!(crc32(b""), 0);
    // Node: crc32(Buffer.from('123456789')) === 0xcbf43926
    assert_eq!(crc32(b"123456789"), 0xcbf4_3926);
  }
}

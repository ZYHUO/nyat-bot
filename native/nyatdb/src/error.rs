use thiserror::Error;

#[derive(Debug, Error)]
pub enum NyatError {
  #[error("io: {0}")]
  Io(#[from] std::io::Error),
  #[error("nyatdb closed")]
  Closed,
  #[error("heap: bad pageId {0}")]
  BadPageId(u32),
  #[error("heap: bad magic page {0}")]
  BadMagic(u32),
  #[error("heap: crc fail page {0}")]
  CrcFail(u32),
  #[error("{0}")]
  Msg(String),
}

pub type Result<T> = std::result::Result<T, NyatError>;

impl From<NyatError> for napi::Error {
  fn from(e: NyatError) -> Self {
    napi::Error::from_reason(e.to_string())
  }
}

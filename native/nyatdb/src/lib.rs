//! NyatDB native engine — Rust / napi-rs (schema v3).

#![deny(clippy::all)]

mod codec;
mod constants;
mod crc32;
mod engine;
mod error;
mod heap;
mod msg_index;
mod page;
mod pool;
mod wal;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use parking_lot::Mutex;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use codec::{role_name, BondTuple, ImpulseTuple, RecallRec, RECALL_DIM};
use constants::SCHEMA_VERSION;
use engine::{Engine, OpenOpts};

fn now_ms() -> u64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_millis() as u64)
    .unwrap_or(0)
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct OpenOptions {
  pub path: String,
  pub sync_every: Option<u32>,
  pub pool_frames: Option<u32>,
  pub chat_ring_max: Option<u32>,
  pub verify_on_open: Option<bool>,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct EngineStatsJs {
  pub pages: u32,
  pub chats: u32,
  pub recalls: u32,
  pub indexed: u32,
  pub lsn: String,
  pub backend: String,
  pub schema: u32,
  pub pool_cached: u32,
  pub pool_dirty: u32,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct ChatMessageJs {
  pub message_id: u32,
  pub ts: f64,
  pub uid: u32,
  pub role: u32,
  pub role_name: String,
  pub text: String,
  /// "text" | "json"
  pub body_format: String,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct ChatAppendInput {
  pub message_id: u32,
  pub ts: f64,
  pub uid: u32,
  /// "user" | "assistant" | "system"
  pub role: String,
  pub text: String,
  /// "text" | "json" — default text
  pub body_format: Option<String>,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct ImpulseJs {
  pub id: String,
  pub chat_id: f64,
  pub run_at: f64,
  pub kind: String,
  pub payload: Vec<u8>,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct BondJs {
  pub uid: u32,
  pub chat_id: f64,
  pub score: f64,
  pub note: String,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct RecallHitJs {
  pub chat_id: f64,
  pub message_id: u32,
  pub score: f64,
}

#[napi]
pub struct NyatDbNative {
  inner: Mutex<Option<Engine>>,
}

#[napi]
impl NyatDbNative {
  #[napi(factory)]
  pub fn open(opts: OpenOptions) -> Result<Self> {
    let eng = Engine::open(OpenOpts {
      path: PathBuf::from(&opts.path),
      sync_every: opts.sync_every.unwrap_or(8),
      pool_frames: opts.pool_frames.unwrap_or(64).max(8),
      chat_ring_max: opts.chat_ring_max.unwrap_or(200).max(50),
      verify_on_open: opts.verify_on_open.unwrap_or(false),
    })?;
    Ok(Self {
      inner: Mutex::new(Some(eng)),
    })
  }

  fn with_mut<T>(&self, f: impl FnOnce(&mut Engine) -> crate::error::Result<T>) -> Result<T> {
    let mut g = self.inner.lock();
    let eng = g.as_mut().ok_or_else(|| Error::from_reason("nyatdb closed"))?;
    f(eng).map_err(Into::into)
  }

  #[napi]
  pub fn path(&self) -> Result<String> {
    let g = self.inner.lock();
    let eng = g.as_ref().ok_or_else(|| Error::from_reason("nyatdb closed"))?;
    Ok(eng.path.display().to_string())
  }

  #[napi]
  pub fn stats(&self) -> Result<EngineStatsJs> {
    let g = self.inner.lock();
    let eng = g.as_ref().ok_or_else(|| Error::from_reason("nyatdb closed"))?;
    let st = eng.stats();
    Ok(EngineStatsJs {
      pages: st.pages,
      chats: st.chats,
      recalls: st.recalls,
      indexed: st.indexed,
      lsn: st.lsn.to_string(),
      backend: "native-rust".into(),
      schema: SCHEMA_VERSION,
      pool_cached: st.pool.0 as u32,
      pool_dirty: st.pool.1 as u32,
    })
  }

  #[napi]
  pub fn checkpoint(&self) -> Result<()> {
    self.with_mut(|e| e.checkpoint())
  }

  #[napi]
  pub fn verify(&self) -> Result<u32> {
    self.with_mut(|e| e.verify())
  }

  #[napi]
  pub fn chat_append(&self, chat_id: f64, msg: ChatAppendInput) -> Result<()> {
    let role = match msg.role.as_str() {
      "assistant" => 1u8,
      "system" => 2,
      _ => 0,
    };
    let body_json = matches!(msg.body_format.as_deref(), Some("json"));
    self.with_mut(|e| {
      e.chat_append(
        chat_id as i64,
        msg.message_id,
        msg.ts as u64,
        msg.uid,
        role,
        msg.text,
        body_json,
      )
    })
  }

  #[napi]
  pub fn chat_recent(&self, chat_id: f64, limit: Option<u32>) -> Result<Vec<ChatMessageJs>> {
    self.with_mut(|e| {
      let rows = e.chat_recent(chat_id as i64, limit.unwrap_or(50) as usize)?;
      Ok(
        rows
          .into_iter()
          .map(|t| ChatMessageJs {
            message_id: t.message_id,
            ts: t.ts as f64,
            uid: t.uid,
            role: t.role as u32,
            role_name: role_name(t.role).into(),
            text: t.text,
            body_format: if t.body_json { "json".into() } else { "text".into() },
          })
          .collect(),
      )
    })
  }

  #[napi]
  pub fn chat_get(&self, chat_id: f64, message_id: u32) -> Result<Option<ChatMessageJs>> {
    self.with_mut(|e| {
      Ok(e.chat_get(chat_id as i64, message_id)?.map(|t| ChatMessageJs {
        message_id: t.message_id,
        ts: t.ts as f64,
        uid: t.uid,
        role: t.role as u32,
        role_name: role_name(t.role).into(),
        text: t.text,
        body_format: if t.body_json { "json".into() } else { "text".into() },
      }))
    })
  }

  /// Parallel decode batch (rayon). Returns one entry per id (null if missing).
  #[napi]
  pub fn chat_get_batch(
    &self,
    chat_id: f64,
    message_ids: Vec<u32>,
  ) -> Result<Vec<Option<ChatMessageJs>>> {
    self.with_mut(|e| {
      let rows = e.chat_get_batch(chat_id as i64, &message_ids)?;
      Ok(
        rows
          .into_iter()
          .map(|opt| {
            opt.map(|t| ChatMessageJs {
              message_id: t.message_id,
              ts: t.ts as f64,
              uid: t.uid,
              role: t.role as u32,
              role_name: role_name(t.role).into(),
              text: t.text,
              body_format: if t.body_json { "json".into() } else { "text".into() },
            })
          })
          .collect(),
      )
    })
  }

  #[napi]
  pub fn chat_trim_keep_last(&self, chat_id: f64, keep: u32) -> Result<()> {
    self.with_mut(|e| e.chat_trim_keep_last(chat_id as i64, keep as usize))
  }

  #[napi]
  pub fn hot_set(&self, key: String, value: Buffer, ttl_ms: Option<f64>) -> Result<()> {
    self.with_mut(|e| e.hot_set(&key, value.as_ref(), ttl_ms.unwrap_or(0.0) as u64))
  }

  #[napi]
  pub fn hot_get(&self, key: String) -> Result<Option<Buffer>> {
    self.with_mut(|e| Ok(e.hot_get(&key)?.map(Buffer::from)))
  }

  #[napi]
  pub fn hot_get_string(&self, key: String) -> Result<Option<String>> {
    self.with_mut(|e| {
      Ok(
        e.hot_get(&key)?
          .map(|b| String::from_utf8_lossy(&b).into_owned()),
      )
    })
  }

  #[napi]
  pub fn hot_del(&self, key: String) -> Result<()> {
    self.with_mut(|e| e.hot_del(&key))
  }

  #[napi]
  pub fn impulse_schedule(
    &self,
    id: String,
    chat_id: f64,
    run_at: f64,
    kind: String,
    payload: Buffer,
  ) -> Result<()> {
    self.with_mut(|e| {
      e.impulse_schedule(ImpulseTuple {
        id,
        chat_id: chat_id as i64,
        run_at: run_at as u64,
        kind,
        payload: payload.to_vec(),
      })
    })
  }

  #[napi]
  pub fn impulse_due(&self, now: Option<f64>, limit: Option<u32>) -> Result<Vec<ImpulseJs>> {
    let now = now.map(|n| n as u64).unwrap_or_else(now_ms);
    self.with_mut(|e| {
      let rows = e.impulse_due(now, limit.unwrap_or(32) as usize)?;
      Ok(
        rows
          .into_iter()
          .map(|j| ImpulseJs {
            id: j.id,
            chat_id: j.chat_id as f64,
            run_at: j.run_at as f64,
            kind: j.kind,
            payload: j.payload,
          })
          .collect(),
      )
    })
  }

  #[napi]
  pub fn impulse_ack(&self, id: String) -> Result<()> {
    self.with_mut(|e| e.impulse_ack(&id))
  }

  #[napi]
  pub fn bond_upsert(&self, b: BondJs) -> Result<()> {
    self.with_mut(|e| {
      e.bond_upsert(BondTuple {
        uid: b.uid,
        chat_id: b.chat_id as i64,
        score: b.score as f32,
        note: b.note,
      })
    })
  }

  #[napi]
  pub fn bond_list(&self, limit: Option<u32>) -> Result<Vec<BondJs>> {
    self.with_mut(|e| {
      let rows = e.bond_list(limit.unwrap_or(100) as usize)?;
      Ok(
        rows
          .into_iter()
          .map(|b| BondJs {
            uid: b.uid,
            chat_id: b.chat_id as f64,
            score: b.score as f64,
            note: b.note,
          })
          .collect(),
      )
    })
  }

  #[napi]
  pub fn recall_upsert(
    &self,
    chat_id: f64,
    message_id: u32,
    vector: Float64Array,
    visibility: Option<u32>,
  ) -> Result<()> {
    if vector.len() != RECALL_DIM {
      return Err(Error::from_reason(format!(
        "recall expects {RECALL_DIM}-d vector"
      )));
    }
    let v: Vec<f32> = vector.as_ref().iter().map(|x| *x as f32).collect();
    self.with_mut(|e| {
      e.recall_upsert(RecallRec {
        chat_id: chat_id as i64,
        message_id,
        visibility: visibility.unwrap_or(1) as u8,
        vector: v,
      })
    })
  }

  #[napi]
  pub fn recall_search(
    &self,
    query: Float64Array,
    chat_id: Option<f64>,
    top_k: Option<u32>,
  ) -> Result<Vec<RecallHitJs>> {
    let q: Vec<f32> = query.as_ref().iter().map(|x| *x as f32).collect();
    self.with_mut(|e| {
      let hits = e.recall_search(&q, chat_id.map(|c| c as i64), top_k.unwrap_or(5) as usize);
      Ok(
        hits
          .into_iter()
          .map(|(cid, mid, score)| RecallHitJs {
            chat_id: cid as f64,
            message_id: mid,
            score: score as f64,
          })
          .collect(),
      )
    })
  }

  #[napi]
  pub fn close(&self, skip_checkpoint: Option<bool>) -> Result<()> {
    let mut g = self.inner.lock();
    if let Some(mut eng) = g.take() {
      eng.close(skip_checkpoint.unwrap_or(false))?;
    }
    Ok(())
  }

  #[napi]
  pub fn ping(&self) -> String {
    format!("nyatdb-native/{}", env!("CARGO_PKG_VERSION"))
  }
}

#[napi]
pub fn native_version() -> String {
  env!("CARGO_PKG_VERSION").to_string()
}

#[napi]
pub fn schema_version() -> u32 {
  SCHEMA_VERSION
}

//! Domain tuple codecs — wire-compatible with `src/nyatdb/format/codec.ts`.

use crate::error::{NyatError, Result};

pub const RECALL_DIM: usize = 384;

#[derive(Clone, Debug)]
pub struct ChatTuple {
    pub message_id: u32,
    pub ts: u64,
    pub uid: u32,
    pub role: u8, // 0 user 1 assistant 2 system
    pub text: String,
    /// false = plain text (algo 0/1); true = JSON FormattedMessage (algo 2/3)
    pub body_json: bool,
}

pub fn encode_chat_tuple(t: &ChatTuple) -> Result<Vec<u8>> {
    let text_buf = t.text.as_bytes();
    let (body, use_z) = if text_buf.len() >= 64 {
        let compressed =
            zstd::encode_all(text_buf, 0).map_err(|e| NyatError::Msg(format!("zstd: {e}")))?;
        // Never expand — zstd can grow UTF-8 past a single page's free space.
        if compressed.len() < text_buf.len() {
            (compressed, true)
        } else {
            (text_buf.to_vec(), false)
        }
    } else {
        (text_buf.to_vec(), false)
    };
    let algo: u8 = match (t.body_json, use_z) {
        (false, false) => 0,
        (false, true) => 1,
        (true, false) => 2,
        (true, true) => 3,
    };
    let mut buf = Vec::with_capacity(1 + 4 + 8 + 4 + 1 + 4 + body.len());
    buf.push(algo);
    buf.extend_from_slice(&t.message_id.to_le_bytes());
    buf.extend_from_slice(&t.ts.to_le_bytes());
    buf.extend_from_slice(&t.uid.to_le_bytes());
    buf.push(t.role);
    buf.extend_from_slice(&(body.len() as u32).to_le_bytes());
    buf.extend_from_slice(&body);
    Ok(buf)
}

pub fn decode_chat_tuple(buf: &[u8]) -> Result<ChatTuple> {
    if buf.len() < 18 {
        return Err(NyatError::Msg("chat tuple short".into()));
    }
    let mut o = 0usize;
    let algo = buf[o];
    o += 1;
    let message_id = u32::from_le_bytes(buf[o..o + 4].try_into().unwrap());
    o += 4;
    let ts = u64::from_le_bytes(buf[o..o + 8].try_into().unwrap());
    o += 8;
    let uid = u32::from_le_bytes(buf[o..o + 4].try_into().unwrap());
    o += 4;
    let role = buf[o];
    o += 1;
    let len = u32::from_le_bytes(buf[o..o + 4].try_into().unwrap()) as usize;
    o += 4;
    if o + len > buf.len() {
        return Err(NyatError::Msg("chat tuple trunc".into()));
    }
    let raw = &buf[o..o + len];
    let compressed = algo == 1 || algo == 3;
    let text = if compressed {
        let dec = zstd::decode_all(raw).map_err(|e| NyatError::Msg(format!("zstd: {e}")))?;
        String::from_utf8_lossy(&dec).into_owned()
    } else {
        String::from_utf8_lossy(raw).into_owned()
    };
    let body_json = algo == 2 || algo == 3;
    Ok(ChatTuple {
        message_id,
        ts,
        uid,
        role,
        text,
        body_json,
    })
}

pub fn role_name(role: u8) -> &'static str {
    match role {
        1 => "assistant",
        2 => "system",
        _ => "user",
    }
}

pub fn encode_hot(key: &str, value: &[u8], expires_at: u64) -> Vec<u8> {
    let kb = key.as_bytes();
    let mut buf = Vec::with_capacity(2 + kb.len() + 8 + 4 + value.len());
    buf.extend_from_slice(&(kb.len() as u16).to_le_bytes());
    buf.extend_from_slice(kb);
    buf.extend_from_slice(&expires_at.to_le_bytes());
    buf.extend_from_slice(&(value.len() as u32).to_le_bytes());
    buf.extend_from_slice(value);
    buf
}

pub fn decode_hot(buf: &[u8]) -> Result<(String, Vec<u8>, u64)> {
    if buf.len() < 2 {
        return Err(NyatError::Msg("hot short".into()));
    }
    let klen = u16::from_le_bytes(buf[0..2].try_into().unwrap()) as usize;
    if buf.len() < 2 + klen + 8 + 4 {
        return Err(NyatError::Msg("hot trunc".into()));
    }
    let key = String::from_utf8_lossy(&buf[2..2 + klen]).into_owned();
    let expires_at = u64::from_le_bytes(buf[2 + klen..2 + klen + 8].try_into().unwrap());
    let vlen = u32::from_le_bytes(buf[2 + klen + 8..2 + klen + 12].try_into().unwrap()) as usize;
    let start = 2 + klen + 12;
    if start + vlen > buf.len() {
        return Err(NyatError::Msg("hot value trunc".into()));
    }
    Ok((key, buf[start..start + vlen].to_vec(), expires_at))
}

#[derive(Clone, Debug)]
pub struct ImpulseTuple {
    pub id: String,
    pub chat_id: i64,
    pub run_at: u64,
    pub kind: String,
    pub payload: Vec<u8>,
}

pub fn encode_impulse(t: &ImpulseTuple) -> Vec<u8> {
    let idb = t.id.as_bytes();
    let kb = t.kind.as_bytes();
    let mut buf = Vec::with_capacity(2 + idb.len() + 8 + 8 + 2 + kb.len() + 4 + t.payload.len());
    buf.extend_from_slice(&(idb.len() as u16).to_le_bytes());
    buf.extend_from_slice(idb);
    buf.extend_from_slice(&t.chat_id.to_le_bytes());
    buf.extend_from_slice(&t.run_at.to_le_bytes());
    buf.extend_from_slice(&(kb.len() as u16).to_le_bytes());
    buf.extend_from_slice(kb);
    buf.extend_from_slice(&(t.payload.len() as u32).to_le_bytes());
    buf.extend_from_slice(&t.payload);
    buf
}

pub fn decode_impulse(buf: &[u8]) -> Result<ImpulseTuple> {
    let mut o = 0usize;
    let idl = u16::from_le_bytes(buf[o..o + 2].try_into().unwrap()) as usize;
    o += 2;
    let id = String::from_utf8_lossy(&buf[o..o + idl]).into_owned();
    o += idl;
    let chat_id = i64::from_le_bytes(buf[o..o + 8].try_into().unwrap());
    o += 8;
    let run_at = u64::from_le_bytes(buf[o..o + 8].try_into().unwrap());
    o += 8;
    let kl = u16::from_le_bytes(buf[o..o + 2].try_into().unwrap()) as usize;
    o += 2;
    let kind = String::from_utf8_lossy(&buf[o..o + kl]).into_owned();
    o += kl;
    let pl = u32::from_le_bytes(buf[o..o + 4].try_into().unwrap()) as usize;
    o += 4;
    let payload = buf[o..o + pl].to_vec();
    Ok(ImpulseTuple {
        id,
        chat_id,
        run_at,
        kind,
        payload,
    })
}

#[derive(Clone, Debug)]
pub struct BondTuple {
    pub uid: u32,
    pub chat_id: i64,
    pub score: f32,
    pub note: String,
}

pub fn encode_bond(t: &BondTuple) -> Vec<u8> {
    let nb = t.note.as_bytes();
    let mut buf = Vec::with_capacity(4 + 8 + 4 + 2 + nb.len());
    buf.extend_from_slice(&t.uid.to_le_bytes());
    buf.extend_from_slice(&t.chat_id.to_le_bytes());
    buf.extend_from_slice(&t.score.to_le_bytes());
    buf.extend_from_slice(&(nb.len() as u16).to_le_bytes());
    buf.extend_from_slice(nb);
    buf
}

pub fn decode_bond(buf: &[u8]) -> Result<BondTuple> {
    let uid = u32::from_le_bytes(buf[0..4].try_into().unwrap());
    let chat_id = i64::from_le_bytes(buf[4..12].try_into().unwrap());
    let score = f32::from_le_bytes(buf[12..16].try_into().unwrap());
    let nlen = u16::from_le_bytes(buf[16..18].try_into().unwrap()) as usize;
    let note = String::from_utf8_lossy(&buf[18..18 + nlen]).into_owned();
    Ok(BondTuple {
        uid,
        chat_id,
        score,
        note,
    })
}

#[derive(Clone, Debug)]
pub struct RecallRec {
    pub chat_id: i64,
    pub message_id: u32,
    pub visibility: u8,
    pub vector: Vec<f32>,
}

pub fn encode_recall(r: &RecallRec) -> Result<Vec<u8>> {
    if r.vector.len() != RECALL_DIM {
        return Err(NyatError::Msg("recall dim".into()));
    }
    let mut buf = vec![0u8; 8 + 4 + 1 + RECALL_DIM * 4];
    buf[0..8].copy_from_slice(&r.chat_id.to_le_bytes());
    buf[8..12].copy_from_slice(&r.message_id.to_le_bytes());
    buf[12] = r.visibility;
    for (i, v) in r.vector.iter().enumerate() {
        buf[13 + i * 4..17 + i * 4].copy_from_slice(&v.to_le_bytes());
    }
    Ok(buf)
}

pub fn decode_recall(buf: &[u8]) -> Result<RecallRec> {
    if buf.len() < 13 + RECALL_DIM * 4 {
        return Err(NyatError::Msg("recall short".into()));
    }
    let chat_id = i64::from_le_bytes(buf[0..8].try_into().unwrap());
    let message_id = u32::from_le_bytes(buf[8..12].try_into().unwrap());
    let visibility = buf[12];
    let mut vector = Vec::with_capacity(RECALL_DIM);
    for i in 0..RECALL_DIM {
        vector.push(f32::from_le_bytes(
            buf[13 + i * 4..17 + i * 4].try_into().unwrap(),
        ));
    }
    Ok(RecallRec {
        chat_id,
        message_id,
        visibility,
        vector,
    })
}

pub fn cosine(a: &[f32], b: &[f32]) -> f32 {
    let n = a.len().min(b.len());
    let mut dot = 0f32;
    let mut na = 0f32;
    let mut nb = 0f32;
    for i in 0..n {
        let x = a[i];
        let y = b[i];
        dot += x * y;
        na += x * x;
        nb += y * y;
    }
    let d = na.sqrt() * nb.sqrt();
    if d == 0.0 {
        0.0
    } else {
        dot / d
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chat_roundtrip() {
        let t = ChatTuple {
            message_id: 7,
            ts: 123,
            uid: 1,
            role: 0,
            text: "你好".into(),
            body_json: false,
        };
        let enc = encode_chat_tuple(&t).unwrap();
        let d = decode_chat_tuple(&enc).unwrap();
        assert_eq!(d.text, "你好");
        assert_eq!(d.message_id, 7);
        assert!(!d.body_json);

        let j = ChatTuple {
            message_id: 8,
            ts: 124,
            uid: 2,
            role: 0,
            text: r#"{"textContent":"hi","username":"a"}"#.into(),
            body_json: true,
        };
        let encj = encode_chat_tuple(&j).unwrap();
        let dj = decode_chat_tuple(&encj).unwrap();
        assert!(dj.body_json);
        assert_eq!(dj.text, j.text);
    }
}

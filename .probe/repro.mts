// Main repro for the "Memory write failed (non-critical)" / "terminated: other side closed" issue.
// Mirrors production: QdrantClient({ host, port, https:false }), upsert, wait:false, 384-dim.
import { QdrantClient, ApiClient } from '@qdrant/js-client-rest';
import { Agent, request as undiciRequest } from 'undici';
import { createHash, randomUUID } from 'node:crypto';

const HOST = '127.0.0.1', PORT = 6333;
const COL = 'probe_repro_v1';
const DIM = 384;

// deterministic uuid v5 (mirror of production midToPointId shape — Qdrant needs UUID/uint64)
const NS = Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex');
function uuid5(s: string): string {
  const h = Buffer.from(createHash('sha1').update(NS).update(s, 'utf8').digest().subarray(0, 16));
  h[6] = (h[6]! & 0x0f) | 0x50; h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.toString('hex');
  return `${x.slice(0,8)}-${x.slice(8,12)}-${x.slice(12,16)}-${x.slice(16,20)}-${x.slice(20)}`;
}
// deterministic-ish 384-dim unit vector (content is irrelevant to the network failure mode)
function vec(seed: string): number[] {
  let h1 = 2166136261;
  for (const ch of seed) { h1 ^= ch.charCodeAt(0); h1 = Math.imul(h1, 16777619); }
  const v: number[] = [];
  let x = (h1 ^ 0x9e3779b9) >>> 0;
  for (let i = 0; i < DIM; i++) { x = (Math.imul(x, 1103515245) + 12345) & 0x7fffffff; v.push((x / 0x7fffffff) - 0.5); }
  const n = Math.hypot(...v) || 1;
  return v.map((y) => y / n);
}
const TERM = (e: unknown) => /terminated|other side closed|UND_ERR_SOCKET|ECONNRESET|fetch failed/i.test(e instanceof Error ? e.message : String(e));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function tryRealVector(): Promise<number[] | null> {
  try {
    const { pipeline } = await import('@xenova/transformers');
    const ex = await pipeline('feature-extraction', 'Xenova/paraphrase-multilingual-MiniLM-L12-v2', {
      progress_callback: undefined,
    });
    const out = await ex('一只戴着樱桃发夹的橘猫', { pooling: 'mean', normalize: true });
    const v = Array.from(out.data as Float32Array);
    if (v.length === DIM) { console.log(`[embed] REAL production embedding (len ${v.length})`); return v; }
    console.log(`[embed] got len ${v.length}, expected ${DIM} — synthetic fallback`);
  } catch (err) {
    console.log(`[embed] model unavailable (${(err as Error).message.split('\n')[0]}) — synthetic 384-dim (content is irrelevant to the network failure mode; only dim matters)`);
  }
  return null;
}

const summary: Record<string, string> = {};
async function main() {
  const realVec = await tryRealVector();
  const client = new QdrantClient({ host: HOST, port: PORT, https: false });

  // fresh probe collection mirroring production (384, Cosine, on_disk)
  try { await client.deleteCollection(COL, { timeout: 5 }); } catch { /* ignore */ }
  await client.createCollection(COL, { vectors: { size: DIM, distance: 'Cosine', on_disk: true } });
  const base = `http://${HOST}:${PORT}`;
  const upsertOn = (client as any).upsert.bind(client);
  // retrieve points (with tiny poll to absorb wait:false async apply)
  async function exists(id: string): Promise<boolean> {
    for (let i = 0; i < 6; i++) {
      try {
        const r = await client.retrieve(COL, { ids: [id], with_vector: false, with_payload: false });
        if (r.length > 0) return true;
      } catch (e) { void e; }
      await sleep(120);
    }
    return false;
  }
  async function upsertWait(id: string, vector: number[], wait: boolean) {
    return upsertOn(COL, { wait, points: [{ id, vector, payload: { probe: true, ts: id } }] });
  }

  // ---- Exp 0: idempotency — upsert SAME id 3x, count points (retry-duplicate test) ----
  {
    const dupId = uuid5('probe-dup-key');
    for (let i = 0; i < 3; i++) { try { await upsertWait(dupId, realVec ?? vec('dup'), false); } catch { /* ignore */ } }
    await sleep(300);
    const r = await client.retrieve(COL, { ids: [dupId], with_vector: false, with_payload: false });
    summary['exp0_idempotency_same_id_3x_point_count'] = String(r.length);
  }

  // ---- Exp 1: rapid, NO idle gap (baseline) ----
  {
    let ok = 0, term = 0, other = 0;
    for (let i = 0; i < 40; i++) {
      const id = uuid5(`rapid-${i}-${randomUUID()}`);
      try { await upsertWait(id, realVec ?? vec('rapid' + i), false); ok++; }
      catch (e) { if (TERM(e)) term++; else other++; }
    }
    summary['exp1_no_idle_40'] = `ok=${ok} terminated=${term} other=${other}`;
  }

  // helper: force idle keep-alive gap so the server closes the pooled sockets
  async function gap() { await sleep(6500); }

  // ---- Exp 2: idle race, SERIAL, wait:false + verify existence of each terminated (the B question) ----
  {
    // warm pool
    for (let i = 0; i < 3; i++) { try { await upsertWait(uuid5(`warm2-${i}`), realVec ?? vec('warm'), false); } catch { /* */ } }
    await gap();
    let term = 0, ok = 0, other = 0, termLanded = 0, termLost = 0;
    for (let i = 0; i < 30; i++) {
      const id = uuid5(`idle2-${i}-${randomUUID()}`);
      try { await upsertWait(id, realVec ?? vec('idle2' + i), false); ok++; }
      catch (e) {
        if (TERM(e)) {
          term++;
          if (await exists(id)) termLanded++; else termLost++;
        } else other++;
      }
    }
    summary['exp2_idle_serial_waitfalse_30'] = `ok=${ok} terminated=${term} other=${other} | of ${term} terminated: landed=${termLanded} LOST=${termLost}`;
    summary['exp2_lost_ids_check_via_count'] = String(await pointsCount());
  }

  // ---- Exp 3: concurrency after idle, wait:false ----
  {
    for (let i = 0; i < 3; i++) { try { await upsertWait(uuid5(`warm3-${i}`), realVec ?? vec('warm'), false); } catch { /* */ } }
    await gap();
    const ids = Array.from({ length: 12 }, () => uuid5(`idle3-${randomUUID()}`));
    const res = await Promise.allSettled(ids.map((id) => upsertWait(id, realVec ?? vec('idle3'), false)));
    let term = 0, ok = 0, other = 0, termLanded = 0, termLost = 0;
    await Promise.all(res.map(async (r, i) => {
      if (r.status === 'fulfilled') { ok++; }
      else if (TERM(r.reason)) { term++; if (await exists(ids[i]!)) termLanded++; else termLost++; }
      else other++;
    }));
    summary['exp3_idle_concurrent12_waitfalse'] = `ok=${ok} terminated=${term} other=${other} | of ${term} terminated: landed=${termLanded} LOST=${termLost}`;
  }

  // ---- Exp 4: idle race, wait:TRUE (does wait flag correlate?) ----
  {
    for (let i = 0; i < 3; i++) { try { await upsertWait(uuid5(`warm4-${i}`), realVec ?? vec('warm'), false); } catch { /* */ } }
    await gap();
    let term = 0, ok = 0, other = 0;
    for (let i = 0; i < 30; i++) {
      const id = uuid5(`idle4-${i}-${randomUUID()}`);
      try { await upsertWait(id, realVec ?? vec('idle4' + i), true); ok++; }
      catch (e) { if (TERM(e)) term++; else other++; }
    }
    summary['exp4_idle_serial_waittrue_30'] = `ok=${ok} terminated=${term} other=${other}`;
  }

  // ---- Exp 5: exact production withQdrantRetry logic, idle — how many FINALLY fail (=> the warn) ----
  {
    for (let i = 0; i < 3; i++) { try { await upsertWait(uuid5(`warm5-${i}`), realVec ?? vec('warm'), false); } catch { /* */ } }
    await gap();
    async function withRetry(fn: () => Promise<unknown>): Promise<number> {
      const delays = [0, 150, 400];
      let attempts = 0;
      let lastErr: unknown;
      for (let i = 0; i < delays.length; i++) {
        if (delays[i]! > 0) await sleep(delays[i]!);
        try { await fn(); return i + 1; } catch (e) { lastErr = e; attempts = i + 1; if (!TERM(e)) return -attempts; }
      }
      void lastErr; return attempts; // all 3 failed => generates the warn
    }
    let finallyFailed = 0, termFirstHit = 0, lost = 0;
    for (let i = 0; i < 30; i++) {
      const id = uuid5(`idle5-${i}-${randomUUID()}`);
      const n = await withRetry(() => upsertWait(id, realVec ?? vec('idle5' + i), false));
      if (n >= 3) { finallyFailed++; if (!(await exists(id))) lost++; }
      if (n === -1 || n === -2 || n === -3) termFirstHit++;
    }
    summary['exp5_production_retry_idle_30'] = `finally_failed(all3)=${finallyFailed} non_transient_firstfail=${termFirstHit} | of finally-failed, actually LOST=${lost}`;
  }

  // ---- Exp 6: FIX PROOF — raw undici upsert with keepAliveTimeout=2000 (< server 5s) ----
  {
    const agent = new Agent({ connections: 25, keepAliveTimeout: 2000, bodyTimeout: 0, headersTimeout: 0 });
    // warm
    for (let i = 0; i < 3; i++) await rawUpsert(uuid5(`raw-warm-${i}`), vec('rawwarm'), false);
    await gap(); // same 6.5s idle that killed the production client above
    let term = 0, ok = 0;
    for (let i = 0; i < 30; i++) {
      const id = uuid5(`raw-idle-${i}-${randomUUID()}`);
      try { await rawUpsert(id, vec('rawidle' + i), false); ok++; }
      catch (e) { if (TERM(e)) term++; else ok++; }
    }
    summary['exp6_keepalive2000_idle_30'] = `ok=${ok} terminated=${term}  (server ka=~5s, client ka=2s => client closes first)`;
    async function rawUpsert(id: string, vector: number[], wait: boolean) {
      const body = JSON.stringify({ wait, points: [{ id, vector, payload: { probe: true } }] });
      const r = await undiciRequest(`${base}/collections/${COL}/points?wait=${wait}`, {
        method: 'PUT', dispatcher: agent, headers: { 'content-type': 'application/json' }, body,
      });
      if (r.statusCode >= 400) throw new Error(`HTTP ${r.statusCode}`);
      await r.body.text();
    }
  }

  await client.deleteCollection(COL, { timeout: 5 });
}

async function pointsCount(): Promise<number> {
  const client = new QdrantClient({ host: HOST, port: PORT, https: false });
  try { return (await client.count(COL, { exact: true })).count; } catch { return -1; }
}

await main();
console.log('\n================ SUMMARY ================');
for (const [k, v] of Object.entries(summary)) console.log(`${k.padEnd(42)} ${v}`);

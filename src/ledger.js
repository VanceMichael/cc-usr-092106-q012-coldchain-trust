// 放行账本：只追加。放行时把 as_of 之前可见的证据判定快照固化进条目；
// 晚到的片段不允许修改旧条目，只能新增 revocation 指向它，哈希链全程可验算。
import { ms, iso } from './time.js';
import { indexEvidence } from './evidence.js';
import { replayContainment } from './containment.js';
import { evaluateBatch, hashEntry } from './evaluation.js';

export function buildLedger(pack, requests) {
  const idx = indexEvidence(pack);
  const replay = replayContainment(idx);
  const entries = [];
  let prevHash = 'GENESIS';
  let seq = 0;

  for (const req of requests) {
    seq += 1;
    const evals = req.batch_ids.map((b) => evaluateBatch(idx, replay, b, req.at));
    const decision = evals.every((e) => e.compliant) && req.intent !== 'revoke' ? 'released' : 'revoked';
    const basis = {
      as_of: req.at,
      verified_intervals: evals.flatMap((e) => e.verified_intervals),
      gaps: evals.flatMap((e) => e.gaps),
      excursions: evals.flatMap((e) => e.excursions),
      segments_used: [...new Set(evals.flatMap((e) => e.segments_used))],
      data_complete: evals.every((e) => e.gaps.length === 0)
    };
    const entry = {
      entry_id: req.entry_id,
      seq,
      at: req.at,
      kind: req.intent === 'revoke' ? 'revocation' : 'release',
      decision,
      batch_ids: req.batch_ids,
      rule_id: evals[0].rule.rule_id,
      rule_version: evals[0].rule.version,
      signer: req.signer,
      supersedes_entry_id: req.supersedes_entry_id || null,
      reason: req.reason || null,
      new_segments: req.new_segments || [],
      basis,
      prev_hash: prevHash,
      entry_hash: ''
    };
    entry.entry_hash = hashEntry(entry, prevHash);
    entries.push(entry);
    prevHash = entry.entry_hash;
  }
  return entries;
}

// 验算已有账本：重算每条哈希，确认没有任何旧条目被悄悄改写。
export function verifyLedger(entries) {
  let prevHash = 'GENESIS';
  for (const e of entries) {
    const expect = hashEntry(e, prevHash);
    if (expect !== e.entry_hash) {
      return { ok: false, tampered_entry: e.entry_id, expected: expect, actual: e.entry_hash };
    }
    if (e.prev_hash !== prevHash) {
      return { ok: false, tampered_entry: e.entry_id, reason: 'prev_hash 断链' };
    }
    prevHash = e.entry_hash;
  }
  return { ok: true };
}

// 某批次当前（截至 asOf）的放行状态：被撤销即 revoked，并带回撤销依据。
export function releaseStatus(pack, batchId, asOf) {
  const ledger = pack.release_ledger.filter((e) => ms(e.at) <= ms(asOf));
  const relevant = ledger.filter((e) => e.batch_ids.includes(batchId));
  const last = relevant[relevant.length - 1];
  if (!last) return { batch_id: batchId, status: 'never_released' };
  if (last.kind === 'revocation') {
    const original = ledger.find((e) => e.entry_id === last.supersedes_entry_id);
    return {
      batch_id: batchId,
      status: 'revoked',
      revoked_entry: last.entry_id,
      revoked_at: last.at,
      signer: last.signer,
      reason: last.reason,
      new_segments: last.new_segments,
      released_entry: original?.entry_id || null,
      released_at: original?.at || null
    };
  }
  return { batch_id: batchId, status: 'released', entry: last.entry_id, at: last.at };
}

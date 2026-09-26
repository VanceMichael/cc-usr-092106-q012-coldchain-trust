// 接收方扫描一箱药：以扫描时刻为准，展示箱内批次的可核验区间、超限、缺口与当前放行状态。
import { indexEvidence } from './evidence.js';
import { replayContainment } from './containment.js';
import { evaluateBatch } from './evaluation.js';
import { releaseStatus } from './ledger.js';
import { ancestors } from './genealogy.js';
import { displayInTimeZone } from './time.js';

// 祖先批次的放行是否已被撤销（父批次出事，子批次即使自身数据合规也要被警示并等待处置）。
function inheritedRevocation(pack, replay, batchId, asOf) {
  for (const a of ancestors(replay, batchId)) {
    const st = releaseStatus(pack, a.batch_id, asOf);
    if (st.status === 'revoked') {
      return { ancestor_batch_id: a.batch_id, revoked_entry: st.revoked_entry, revoked_at: st.revoked_at, reason: st.reason };
    }
  }
  return null;
}


export function scanContainer(pack, containerId, scannedAt, viewerTz = 'UTC') {
  const idx = indexEvidence(pack);
  const replay = replayContainment(idx);
  const container = idx.containers.get(containerId);
  if (!container) throw new Error(`未知箱体 ${containerId}`);

  // 扫描时刻仍在箱内的批次；若箱体已完成签收（货物转入受控存储），
  // 也回显最后承载的批次，并标记 received，便于接收方在撤销到达后扫箱复核。
  const carriedByContainer = (cId) =>
    [...idx.batches.keys()]
      .flatMap((b) => (replay.batchIntervals.get(b) || []).filter((iv) => iv.containerId === cId).map((iv) => ({ b, iv })))
      .sort((a, z) => new Date(z.iv.to) - new Date(a.iv.to));
  const all = carriedByContainer(containerId);
  const insideNow = all
    .filter(({ iv }) => new Date(iv.from) <= new Date(scannedAt) && new Date(iv.to) > new Date(scannedAt))
    .map((x) => ({ ...x, received: false }));
  const inside = insideNow.length
    ? insideNow
    : all.length && new Date(all[0].iv.to) <= new Date(scannedAt)
      ? [{ ...all[0], received: true }]
      : [];

  const cosmetic = container.kind === 'foam_wrapped';
  const batches = inside.map(({ b, received }) => {
    const e = evaluateBatch(idx, replay, b, scannedAt);
    const status = releaseStatus(pack, b, scannedAt);
    const inherited = inheritedRevocation(pack, replay, b, scannedAt);
    return {
      batch_id: b,
      received,
      product_name: idx.batches.get(b).product_name,
      compliant: e.compliant,
      release_status: status.status,
      inherited_revocation: inherited,
      verified_intervals: e.verified_intervals.map((v) => ({
        from_local: displayInTimeZone(v.from, viewerTz),
        to_local: displayInTimeZone(v.to, viewerTz)
      })),
      excursions: e.excursions,
      gaps: e.gaps.map((g) => ({
        reason: g.reason,
        from_local: displayInTimeZone(g.from, viewerTz),
        to_local: displayInTimeZone(g.to, viewerTz)
      })),
      unsigned_handovers: e.unsigned_handovers
    };
  });

  const allClear = batches.every(
    (b) => b.compliant && b.release_status === 'released' && !b.inherited_revocation
  );

  let verdict;
  if (batches.length === 0) {
    verdict = cosmetic ? 'reject_no_evidence' : 'empty_or_unknown';
  } else if (batches.some((b) => b.received)) {
    verdict = allClear ? 'received_clear' : 'received_hold';
  } else {
    verdict = allClear ? 'accept' : 'hold';
  }

  return {
    container_id: containerId,
    container_kind: container.kind,
    looks_like_cold_chain_but_unverified: cosmetic,
    scanned_at_local: displayInTimeZone(scannedAt, viewerTz),
    seal_id: container.seal_id || null,
    verdict,
    batches
  };
}
// 批次谱系与下游追查：拆分产生父子边；撤销沿谱系向下找出所有仍需通知的下游批次与接收方。
import { ms } from './time.js';
import { indexEvidence } from './evidence.js';
import { replayContainment } from './containment.js';
import { releaseStatus } from './ledger.js';

export function descendants(replay, batchId) {
  const out = [];
  const walk = (id, depth) => {
    for (const child of replay.children.get(id) || []) {
      out.push({ batch_id: child, depth: depth + 1 });
      walk(child, depth + 1);
    }
  };
  walk(batchId, 0);
  return out;
}

export function ancestors(replay, batchId) {
  const out = [];
  const walk = (id, depth) => {
    for (const p of replay.parents.get(id) || []) {
      out.push({ batch_id: p, depth: depth + 1 });
      walk(p, depth + 1);
    }
  };
  walk(batchId, 0);
  return out;
}

// 某批次截至某时刻的实际接收方序列（责任段），用于通知与追责。
export function custodyTrail(idx, replay, batchId) {
  return (replay.responsibility.get(batchId) || []).map((iv) => {
    const party = idx.parties.get(iv.partyId);
    return {
      party_id: iv.partyId,
      party_name: party?.name || '未知参与方',
      role: party?.role || 'unlicensed',
      from: iv.from,
      to: iv.to,
      task_id: iv.taskId,
      via_event: iv.viaEvent
    };
  });
}

// 撤销后哪些下游批次仍需通知：谱系向下，凡当前仍持有的参与方且尚未确认的，都列出。
export function downstreamToNotify(pack, revokedBatchId, asOf) {
  const idx = indexEvidence(pack);
  const replay = replayContainment(idx);
  const targets = [revokedBatchId, ...descendants(replay, revokedBatchId).map((d) => d.batch_id)];
  const out = [];
  for (const batchId of targets) {
    const trail = custodyTrail(idx, replay, batchId);
    const holder = trail[trail.length - 1];
    // 实物必须仍被持有（责任段覆盖 asOf）；已拆空的父批次不再另行通知，只通过叶子批次触达。
    if (!holder || new Date(holder.to) < new Date(asOf)) continue;
    const notices = pack.notifications.filter((n) => n.batch_id === batchId);
    const acked = notices.some((n) => n.status === 'acked');
    if (!acked) {
      out.push({
        batch_id: batchId,
        current_holder: holder.party_name,
        party_id: holder.party_id,
        since: holder.from,
        notification_status: notices[0]?.status || 'pending',
        own_release: releaseStatus(pack, batchId, asOf).status
      });
    }
  }
  return out;
}

// 质量负责人视图：某次放行后来为何被撤销，撤销链 + 新证据 + 受影响下游。
export function revocationTrace(pack, releaseEntryId) {
  const idx = indexEvidence(pack);
  const replay = replayContainment(idx);
  const original = pack.release_ledger.find((e) => e.entry_id === releaseEntryId);
  if (!original) throw new Error(`找不到放行条目 ${releaseEntryId}`);
  const chain = [original];
  let cursor = original;
  const newSegments = new Set(cursor.new_segments || []);
  for (;;) {
    const next = pack.release_ledger.find((e) => e.supersedes_entry_id === cursor.entry_id);
    if (!next) break;
    chain.push(next);
    next.new_segments.forEach((s) => newSegments.add(s));
    cursor = next;
  }
  const latest = chain[chain.length - 1];
  let affected = [];
  let pending = [];
  if (latest.kind === 'revocation') {
    // 受影响范围：撤销时仍持有实物的本批次与全部下游叶子批次（不论是否已确认）。
    affected = downstreamHolders(pack, idx, replay, original.batch_ids[0], latest.at);
    pending = downstreamToNotify(pack, original.batch_ids[0], pack.generated_at);
  }
  return {
    release_entry: original.entry_id,
    released_at: original.at,
    release_basis: original.basis,
    release_signer: original.signer,
    rule_at_release: { rule_id: original.rule_id, version: original.rule_version },
    revoked: latest.kind === 'revocation',
    revocation_entry: latest.kind === 'revocation' ? latest.entry_id : null,
    revoked_at: latest.kind === 'revocation' ? latest.at : null,
    revocation_reason: latest.reason,
    revocation_signer: latest.signer,
    late_segments: [...newSegments],
    affected_downstream_batches: affected.map((d) => d.batch_id),
    notifications_pending: pending.map((d) => ({
      batch_id: d.batch_id,
      current_holder: d.current_holder,
      party_id: d.party_id,
      notification_status: d.notification_status
    })),
    chain: chain.map((e) => ({
      entry_id: e.entry_id,
      kind: e.kind,
      at: e.at,
      decision: e.decision,
      signer: e.signer
    }))
  };
}

// 撤销时刻仍持有实物的本批次/下游叶子批次（含已确认者），用于划定影响面。
function downstreamHolders(pack, idx, replay, revokedBatchId, asOf) {
  const targets = [revokedBatchId, ...descendants(replay, revokedBatchId).map((d) => d.batch_id)];
  const out = [];
  for (const batchId of targets) {
    const trail = custodyTrail(idx, replay, batchId);
    const holder = trail[trail.length - 1];
    if (holder && new Date(holder.to) >= new Date(asOf)) {
      const notices = pack.notifications.filter((n) => n.batch_id === batchId);
      out.push({
        batch_id: batchId,
        current_holder: holder.party_name,
        party_id: holder.party_id,
        notification_status: notices[0]?.status || 'pending'
      });
    }
  }
  return out;
}

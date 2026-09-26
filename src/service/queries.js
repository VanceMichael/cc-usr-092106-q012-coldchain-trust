// 查询服务：只读投影，不产生事件。
//  - scanBox：接收方扫一箱药，看到可核验区间、超限与缺口；
//  - batchEvidence：批次跨箱的连续证据链（换箱/拼箱/拆分后仍完整）；
//  - traceRelease：质量负责人追查放行为何被撤销、哪些下游批次仍需通知。
import { intersect, subtract, toIso } from '../domain/time.js';
import { ruleKey } from '../domain/rules.js';
import { buildBoxTimeline, summarize } from '../domain/timeline.js';

function mustBox(state, boxId) {
  const box = state.boxes.get(boxId);
  if (!box) throw new Error(`箱体不存在: ${boxId}`);
  return box;
}

function ruleOf(state, batch) {
  const rule = state.rules.get(ruleKey(batch.ruleId, batch.ruleVersion));
  if (!rule) throw new Error(`质量规则不存在: ${batch.ruleId}@${batch.ruleVersion}`);
  return rule;
}

// 箱体在某个窗口内的证据时间线（含传感器身份与校准版本）。
export function boxTimeline(state, boxId, window, rule) {
  const bindings = state.bindings.filter((b) => b.boxId === boxId);
  const segments = state.segments.filter((s) => s.boxId === boxId && s.from < window.to && window.from < s.to);
  const calibrationsBySensor = {};
  for (const [sensorId, sensor] of state.sensors) {
    calibrationsBySensor[sensorId] = sensor.calibrations;
  }
  return buildBoxTimeline({ window, bindings, segments, calibrationsBySensor, rule });
}

// 责任段：由交接链推出谁在何时对该箱负责，并标注当时在执行的承运任务。
// 跨时区运输中交接时间已归一化为 UTC，责任段顺序因此不受时区影响。
export function responsibilitySegments(state, boxId, window) {
  const box = mustBox(state, boxId);
  const handovers = state.handovers
    .filter((h) => h.boxId === boxId)
    .sort((a, b) => a.ts - b.ts);
  const segments = [];
  let holder = box.holder;
  let from = window.from;
  for (const h of handovers) {
    if (h.ts <= window.from) {
      holder = h.toHolder;
      continue;
    }
    if (h.ts >= window.to) break;
    segments.push({ from, to: h.ts, holder });
    holder = h.toHolder;
    from = h.ts;
  }
  segments.push({ from, to: window.to, holder });
  for (const seg of segments) {
    const attachment = state.taskAttachments.find(
      (a) => a.boxId === boxId && a.from < seg.to && (a.to == null || seg.from < a.to),
    );
    if (attachment) {
      seg.taskId = attachment.taskId;
      seg.carrier = state.tasks.get(attachment.taskId)?.carrier ?? null;
    }
  }
  return segments;
}

// 批次证据链：按时间顺序列出批次经过的每个箱体，各段附带该箱的
// 证据时间线、责任段与开箱事件；窗口内无箱体的时段标为 untracked 缺口。
export function batchEvidence(state, batchId, window) {
  const batch = state.batches.get(batchId);
  if (!batch) throw new Error(`批次不存在: ${batchId}`);
  const rule = ruleOf(state, batch);
  const containment = state.containment
    .filter((c) => c.batchId === batchId)
    .sort((a, b) => a.from - b.from);

  const parts = [];
  const coveredWindows = [];
  for (const c of containment) {
    const w = intersect(window, { from: c.from, to: c.to ?? Number.MAX_SAFE_INTEGER });
    if (!w) continue;
    coveredWindows.push(w);
    const timeline = boxTimeline(state, c.boxId, w, rule);
    parts.push({
      boxId: c.boxId,
      from: w.from,
      to: w.to,
      via: c.via,
      holders: responsibilitySegments(state, c.boxId, w),
      opens: state.opens.filter((o) => o.boxId === c.boxId && w.from <= o.ts && o.ts < w.to),
      intervals: timeline.intervals,
      summary: timeline.summary,
    });
  }

  const untracked = subtract(window, coveredWindows).map((p) => ({
    ...p,
    class: 'gap',
    reason: 'untracked',
  }));

  const intervals = [
    ...parts.flatMap((p) => p.intervals.map((iv) => ({ ...iv, boxId: p.boxId }))),
    ...untracked,
  ].sort((a, b) => a.from - b.from || a.to - b.to);

  const summary = summarize(intervals);
  return {
    batchId,
    ruleId: rule.ruleId,
    ruleVersion: rule.version,
    window,
    parts,
    untracked,
    intervals,
    summary,
    boxesInvolved: [...new Set(parts.map((p) => p.boxId))],
  };
}

function latestRelease(state, batchId) {
  const releases = [...state.releases.values()]
    .filter((r) => r.batchId === batchId)
    .sort((a, b) => b.issuedAt - a.issuedAt);
  return releases[0] ?? null;
}

// 接收方扫描视图：一箱药的可核验区间、超限与缺口，以及当前批次的
// 放行状态与处置记录。拼箱中不同批次引用不同规则时按规则分区呈现。
export function scanBox(state, boxId, { from, to, now } = {}) {
  const box = mustBox(state, boxId);
  const window = {
    from: from ?? box.registeredAt,
    to: to ?? (typeof now === 'function' ? now() : Date.now()),
  };
  const currentBatchIds = state.containment
    .filter((c) => c.boxId === boxId && c.to == null)
    .map((c) => c.batchId);

  const byRule = new Map();
  for (const batchId of currentBatchIds) {
    const batch = state.batches.get(batchId);
    const key = ruleKey(batch.ruleId, batch.ruleVersion);
    if (!byRule.has(key)) byRule.set(key, []);
    byRule.get(key).push(batchId);
  }

  const sections = [];
  for (const [key, batchIds] of byRule) {
    const batch = state.batches.get(batchIds[0]);
    const rule = ruleOf(state, batch);
    const timeline = boxTimeline(state, boxId, window, rule);
    sections.push({
      ruleId: rule.ruleId,
      ruleVersion: rule.version,
      intervals: timeline.intervals,
      summary: timeline.summary,
      batches: batchIds.map((batchId) => ({
        batchId,
        release: latestRelease(state, batchId),
        dispositions: state.dispositions.filter((d) => d.batchId === batchId),
      })),
    });
  }

  return {
    boxId,
    window,
    holders: responsibilitySegments(state, boxId, window),
    opens: state.opens.filter((o) => o.boxId === boxId && window.from <= o.ts && o.ts < window.to),
    sections,
  };
}

// 放行追查：结论本身、状态流转历史、触发质疑的晚到片段、
// 以及撤销后产生的下游批次通知（含仍未通知的）。
export function traceRelease(state, releaseId) {
  const release = state.releases.get(releaseId);
  if (!release) throw new Error(`放行结论不存在: ${releaseId}`);
  const lateSegments = release.contestedBy.map((c) => {
    const segment = state.segments.find((s) => s.segmentId === c.segmentId);
    return { ...c, segment: segment ?? null };
  });
  const notifications = [...state.notifications.values()].filter((n) => n.sourceReleaseId === releaseId);
  return {
    release,
    lateSegments,
    notifications,
    pendingBatches: notifications.filter((n) => n.status === 'pending').map((n) => n.batchId),
  };
}

export function pendingNotifications(state) {
  return [...state.notifications.values()].filter((n) => n.status === 'pending');
}

// 供 HTTP 层使用：把时间字段转成 ISO 字符串，便于接收方直接阅读。
export function toIsoView(value) {
  if (Array.isArray(value)) return value.map(toIsoView);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === 'number' && /^(from|to|t|ts|issuedAt|receivedAt|createdAt|revokedAt|confirmedAt|detectedAt|registeredAt|notifiedAt|validFrom|validTo)$/.test(k)) {
        out[k] = toIso(v);
      } else {
        out[k] = toIsoView(v);
      }
    }
    return out;
  }
  return value;
}

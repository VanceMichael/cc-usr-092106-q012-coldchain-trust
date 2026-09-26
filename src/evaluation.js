// 派生判定：在给定 as_of 时刻，只使用当时已上传的证据，重算每个批次的
// 可核验区间、缺口与超限。缺口只标记、不插值；晚于 as_of 上传的片段不可见。
import { createHash } from 'node:crypto';
import { ms, iso, mergeIntervals, gapsWithin } from './time.js';
import { ruleAt } from './evidence.js';

// 返回某容器在 as_of 之前已上传、未被废止的温度片段的样本时间覆盖与读点。
function segmentCoverage(idx, containerId, mounts, asOf) {
  const tMax = ms(asOf);
  const usable = idx.segments.filter(
    (s) => s.status === 'active' && ms(s.uploaded_at) <= tMax
  );
  const mountedHere = (seg) =>
    (mounts.get(containerId) || []).some(
      (m) => m.sensorId === seg.sensor_id && ms(seg.started_at) < ms(m.to) && ms(seg.ended_at) > ms(m.from)
    );
  const segs = usable.filter(mountedHere);
  if (segs.length === 0) return { covered: [], offlineHoles: [], readings: [], segmentIds: [] };

  // 同一传感器上更细粒度的片段（如晚到导出的秒级缓存）在重叠时间遮蔽压缩均值片段：
  // 粗粒度读点在细片段读点附近不作证。遮蔽随上传集合变化，放行当时仍只看到粗片段。
  const finePoints = new Map(); // coarse segmentId -> 细片段读点时刻集合
  for (const coarse of segs) {
    const pts = segs
      .filter((fine) => fine.sensor_id === coarse.sensor_id && fine.interval_s < coarse.interval_s)
      .flatMap((fine) => fine.samples.map((s) => ms(s.t)).filter((t) => t <= tMax));
    finePoints.set(coarse.segment_id, new Set(pts));
  }
  const halfFine = (seg) => {
    const finer = segs
      .filter((f) => f.sensor_id === seg.sensor_id && f.interval_s < seg.interval_s)
      .sort((a, b) => a.interval_s - b.interval_s);
    return finer.length ? (finer[0].interval_s * 1000) / 2 : 0;
  };
  const isMasked = (seg, t) => {
    const set = finePoints.get(seg.segment_id);
    if (!set || set.size === 0) return false;
    const tol = halfFine(seg);
    for (const ft of set) if (Math.abs(ft - t) <= tol) return true;
    return false;
  };

  // 按传感器归并可见读点（粗片段被遮蔽的读点剔除）。
  const bySensor = new Map(); // sensorId -> { points, bounds }
  const segmentIds = [];
  for (const seg of segs) {
    segmentIds.push(seg.segment_id);
    const cal = idx.calibrations.get(seg.calibration_id);
    if (!bySensor.has(seg.sensor_id)) bySensor.set(seg.sensor_id, { points: [], bounds: [] });
    const entry = bySensor.get(seg.sensor_id);
    let hadOwn = false;
    for (const s of seg.samples) {
      const t = ms(s.t);
      if (t > tMax || isMasked(seg, t)) continue;
      hadOwn = true;
      entry.points.push({
        t,
        c: s.c + (cal?.bias_c || 0),
        intervalMs: seg.interval_s * 1000,
        segmentId: seg.segment_id
      });
    }
    // 片段首尾读点把覆盖延拓到片段起止：记录仪的有效作证从启动到关停。
    if (hadOwn) entry.bounds.push({ from: ms(seg.started_at), to: ms(seg.ended_at) });
  }

  const spans = [];
  const offlineHoles = [];
  const readings = [];
  for (const { points: list, bounds } of bySensor.values()) {
    list.sort((a, b) => a.t - b.t);
    for (const p of list) readings.push(p);
    for (let i = 1; i < list.length; i += 1) {
      const a = list[i - 1];
      const b = list[i];
      const delta = b.t - a.t;
      // 相邻已知读点（可能来自不同粒度片段）间隔不超过较粗的采样间隔：区间可核验。
      if (delta <= Math.max(a.intervalMs, b.intervalMs)) {
        spans.push({ from: iso(a.t), to: iso(b.t) });
      } else {
        // 最后已知读点之后温度即未知，直到重新收到读点：掉线缺口。禁止用首尾读数填平。
        offlineHoles.push({ from: iso(a.t), to: iso(b.t), reason: 'sensor_offline' });
      }
    }
    for (const bd of bounds) {
      const inBd = list.filter((p) => p.t >= bd.from && p.t <= bd.to);
      if (inBd.length) {
        spans.push({ from: iso(bd.from), to: iso(inBd[0].t) });
        spans.push({ from: iso(inBd[inBd.length - 1].t), to: iso(bd.to) });
      }
    }
  }
  return {
    covered: mergeIntervals(spans),
    offlineHoles,
    readings,
    segmentIds
  };
}

// 评估单批次在 as_of 时刻的证据状态。
export function evaluateBatch(idx, replay, batchId, asOf) {
  const intervals = replay.batchIntervals.get(batchId) || [];
  const journey = mergeIntervals(intervals.map((i) => ({ from: i.from, to: i.to })));
  const verified = [];
  const gaps = [];
  const readingsAll = [];
  const segmentsUsed = new Set();
  const unsignedHandovers = [];

  for (const rawIv of intervals) {
    // 只评估 as_of 之前（含）的部分；之后是未来，不能预判为缺口。
    if (ms(rawIv.from) > ms(asOf)) continue;
    const iv = { ...rawIv, to: ms(rawIv.to) > ms(asOf) ? asOf : rawIv.to };
    const window = { from: iv.from, to: iv.to };
    const mounts = (replay.sensorMounts.get(iv.containerId) || [])
      .map((m) => ({ ...m }))
      .filter((m) => ms(m.from) < ms(window.to) && (!m.to || ms(m.to) > ms(window.from)));
    if (mounts.length === 0) {
      for (const g of gapsWithin(window, [])) gaps.push({ ...g, reason: 'no_sensor' });
      continue;
    }
    const cov = segmentCoverage(idx, iv.containerId, replay.sensorMounts, asOf);
    cov.readings.forEach((r) => {
      if (r.t >= ms(window.from) && r.t <= ms(window.to)) {
        readingsAll.push({ ...r, containerId: iv.containerId });
      }
    });
    cov.segmentIds.forEach((id) => segmentsUsed.add(id));

    // 安装了传感器但 as_of 时还没有任何片段上传
    const mountedBeforeAsOf = mounts.some((m) => ms(m.from) <= ms(asOf));
    if (mountedBeforeAsOf && cov.covered.length === 0) {
      gaps.push({ ...window, reason: 'no_segment_yet' });
      continue;
    }

    const inWindow = mergeIntervals(
      cov.covered
        .map((c) => intersectOne(c, window))
        .filter(Boolean)
    );
    for (const v of inWindow) verified.push(v);
    // 掉线缺口先扣掉
    const holes = cov.offlineHoles
      .map((h) => ({ gap: intersectOne(h, window), reason: h.reason }))
      .filter((h) => h.gap);
    let covered = inWindow;
    for (const h of holes) {
      covered = subtractInterval(covered, h.gap);
      gaps.push({ ...h.gap, reason: h.reason });
    }
    // 剩余未解释的时间：装了传感器但读点没覆盖到。掉线洞已归因，不再重复标记。
    const explained = mergeIntervals([
      ...covered,
      ...holes.map((h) => h.gap)
    ]);
    for (const g of gapsWithin(window, explained)) {
      gaps.push({ ...g, reason: ms(g.from) >= ms(asOf) ? 'no_segment_yet' : 'no_sensor' });
    }
  }

  // 旅程之外（已离开受控包装、无人签领）的时段
  // 由调用方按需扩展；夹具中责任段断裂通过 unsignedHandovers 暴露。
  for (const ev of idx.events) {
    if (ev.type === 'handover' && ev.signed_by === null && ms(ev.at) <= ms(asOf)) {
      if ((ev.batch_ids || []).includes(batchId)) {
        unsignedHandovers.push({ event_id: ev.event_id, at: ev.at });
      }
    }
  }

  const rule = ruleAt(idx, asOf);
  const excursions = detectExcursions(readingsAll, rule);
  const excursionMinutes = excursions.reduce((sum, e) => sum + (ms(e.to) - ms(e.from)) / 60000, 0);
  // 各缺口在构造时互不重叠（掉线洞从覆盖中扣除，剩余再切），按时间排序保留各自成因。
  const gapsOut = gaps
    .map((g) => ({ batch_id: batchId, from: g.from, to: g.to, reason: g.reason }))
    .sort((a, b) => ms(a.from) - ms(b.from));

  const compliant =
    gapsOut.length === 0 &&
    excursionMinutes <= rule.max_excursion_minutes &&
    unsignedHandovers.length === 0;

  return {
    batch_id: batchId,
    as_of: asOf,
    rule: { rule_id: rule.rule_id, version: rule.version },
    verified_intervals: mergeIntervals(verified).map((v) => ({ batch_id: batchId, ...v })),
    gaps: gapsOut,
    excursions: excursions.map((e) => ({ batch_id: batchId, ...e })),
    excursion_minutes: Math.round(excursionMinutes),
    unsigned_handovers: unsignedHandovers,
    segments_used: [...segmentsUsed],
    compliant
  };
}

function intersectOne(a, b) {
  const from = Math.max(ms(a.from), ms(b.from));
  const to = Math.min(ms(a.to), ms(b.to));
  return from < to ? { from: iso(from), to: iso(to) } : null;
}

function subtractInterval(covered, hole) {
  const h = { from: ms(hole.from), to: ms(hole.to) };
  const out = [];
  for (const iv of covered) {
    const a = ms(iv.from);
    const b = ms(iv.to);
    if (h.to <= a || h.from >= b) {
      out.push(iv);
    } else {
      if (h.from > a) out.push({ from: iso(a), to: iso(Math.min(h.from, b)) });
      if (h.to < b) out.push({ from: iso(Math.max(h.to, a)), to: iso(b) });
    }
  }
  return mergeIntervals(out);
}

function detectExcursions(readings, rule) {
  const out = [];
  let cur = null;
  for (const r of readings.sort((a, b) => a.t - b.t)) {
    const bad = r.c < rule.min_c || r.c > rule.max_c;
    if (bad) {
      if (!cur) cur = { from: iso(r.t), to: iso(r.t), max_c: r.c, min_c: r.c };
      cur.to = iso(r.t);
      cur.max_c = Math.max(cur.max_c, r.c);
      cur.min_c = Math.min(cur.min_c, r.c);
    } else if (cur) {
      out.push(cur);
      cur = null;
    }
  }
  if (cur) out.push(cur);
  return out;
}

// 账本哈希：对条目的规范 JSON 求 SHA-256。晚到数据只能新增撤销条目，
// 因此旧条目的哈希永远可被重新验算。
export function hashEntry(entry, prevHash) {
  const { entry_hash, ...rest } = entry;
  const canon = JSON.stringify({ ...rest, prev_hash: prevHash });
  return createHash('sha256').update(canon).digest('hex');
}

// 证据时间线构建：把箱体在一个窗口内的传感器绑定、温度片段、校准版本
// 折叠成分类区间。核心原则：
//   - 只有真实读数能产生 qualified / excursion 区间；
//   - 没有数据的时段一律标为 gap（缺口），绝不用相邻读数自动填成合格；
//   - 每个区间保留产生它的传感器身份与校准版本。
import { subtract, mergeAdjacent } from './time.js';
import { inBounds } from './rules.js';

// bindings: [{ sensorId, from, to|null, endReason|null }]
// segments: [{ sensorId, from, to, points: [{t, v}], calibrationVersion|null }]
// calibrationsBySensor: { sensorId: [{ version, validFrom, validTo|null }] }
export function buildBoxTimeline({ window, bindings = [], segments = [], calibrationsBySensor = {}, rule }) {
  const expectedMs = rule.expectedIntervalSeconds * 1000;
  const covered = [];

  for (const seg of segments) {
    const points = [...seg.points].sort((a, b) => a.t - b.t);
    points.forEach((p, i) => {
      // 一个读数只覆盖到下一个读数或标称采样间隔结束，二者取早；
      // 超出部分不延伸，留给缺口。
      const next = i + 1 < points.length ? points[i + 1].t : seg.to;
      const from = Math.max(p.t, window.from);
      const to = Math.min(next, p.t + expectedMs, window.to);
      if (from >= to) return;
      const base = { from, to, sensorId: seg.sensorId, calibrationVersion: seg.calibrationVersion ?? null };
      const calibrations = calibrationsBySensor[seg.sensorId] ?? [];
      const calibrationValid =
        seg.calibrationVersion != null &&
        calibrations.some((c) => c.validFrom <= p.t && (c.validTo == null || p.t < c.validTo));
      if (!calibrationValid) {
        // 有数据但校准版本缺失或已过期：不可核验，按缺口对待。
        covered.push({ ...base, class: 'gap', reason: 'calibration_invalid' });
      } else if (inBounds(rule, p.v)) {
        covered.push({ ...base, class: 'qualified' });
      } else {
        covered.push({ ...base, class: 'excursion', value: p.v });
      }
    });
  }

  // 窗口内未被任何读数覆盖的部分都是缺口。先在绑定边界处切开，
  // 再按各小段当时的绑定状态给出原因（在绑无数据/掉线/无传感器）。
  const boundaries = [...new Set(
    bindings.flatMap((b) => [
      Math.max(b.from, window.from),
      b.to == null ? null : Math.min(b.to, window.to),
    ]).filter((x) => x != null && window.from < x && x < window.to),
  )].sort((a, b) => a - b);

  const pieces = subtract(window, covered).flatMap((piece) => splitAt(piece, boundaries));
  const gaps = pieces.map((piece) => {
    const mid = (piece.from + piece.to) / 2;
    const active = bindings.find((b) => b.from <= mid && (b.to == null || mid < b.to));
    if (active) {
      return { ...piece, class: 'gap', reason: 'data_missing', sensorId: active.sensorId };
    }
    const lastEnded = bindings
      .filter((b) => b.to != null && b.to <= mid)
      .sort((a, b) => b.to - a.to)[0];
    return {
      ...piece,
      class: 'gap',
      reason: lastEnded?.endReason === 'offline' ? 'sensor_offline' : 'no_sensor',
    };
  });

  const intervals = mergeAdjacent([...covered, ...gaps], intervalKey);
  return { window, intervals, summary: summarize(intervals) };
}

function intervalKey(iv) {
  return [iv.class, iv.reason ?? '', iv.sensorId ?? '', iv.calibrationVersion ?? ''].join(':');
}

// 在指定边界点处把区间切成小段。
function splitAt(piece, boundaries) {
  const cuts = boundaries.filter((b) => piece.from < b && b < piece.to);
  if (cuts.length === 0) return [piece];
  const out = [];
  let from = piece.from;
  for (const cut of cuts) {
    out.push({ from, to: cut });
    from = cut;
  }
  out.push({ from, to: piece.to });
  return out;
}

export function summarize(intervals) {
  const summary = { qualifiedMs: 0, excursionMs: 0, gapMs: 0 };
  for (const iv of intervals) {
    const d = iv.to - iv.from;
    if (iv.class === 'qualified') summary.qualifiedMs += d;
    else if (iv.class === 'excursion') summary.excursionMs += d;
    else summary.gapMs += d;
  }
  return summary;
}

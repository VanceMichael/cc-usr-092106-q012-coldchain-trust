// 时间与区间工具。
// 所有业务时间在入库前归一化为 UTC 毫秒；跨时区运输中，调用方传入的
// 原始带时区字符串（如 2026-09-26T10:00:00+08:00）会保留在事件的
// tsSource 字段中以便审计，计算一律使用归一化后的 UTC 毫秒。

export function toUtcMs(input, field = 'ts') {
  if (typeof input === 'number' && Number.isFinite(input)) return input;
  if (typeof input === 'string') {
    const ms = Date.parse(input);
    if (!Number.isNaN(ms)) return ms;
  }
  throw new Error(`无法解析时间字段 ${field}: ${JSON.stringify(input)}`);
}

// 归一化时间输入，返回 { ts, tsSource }；tsSource 仅在输入为字符串时保留。
export function normalizeTime(input, field = 'ts') {
  const ts = toUtcMs(input, field);
  return { ts, tsSource: typeof input === 'string' ? input : undefined };
}

export const MINUTE_MS = 60_000;

export function toIso(ms) {
  return new Date(ms).toISOString();
}

// 区间一律按 [from, to) 处理。

export function intersect(a, b) {
  const from = Math.max(a.from, b.from);
  const to = Math.min(a.to, b.to);
  return from < to ? { from, to } : null;
}

export function intersects(a, b) {
  return a.from < b.to && b.from < a.to;
}

// 从 base 区间中扣除 cuts（可相互重叠），返回剩余片段。
export function subtract(base, cuts) {
  let pieces = [{ from: base.from, to: base.to }];
  for (const cut of cuts) {
    const next = [];
    for (const p of pieces) {
      const hit = intersect(p, cut);
      if (!hit) {
        next.push(p);
        continue;
      }
      if (p.from < hit.from) next.push({ from: p.from, to: hit.from });
      if (hit.to < p.to) next.push({ from: hit.to, to: p.to });
    }
    pieces = next;
  }
  return pieces;
}

// 合并首尾相接且 keyOf 相同的相邻区间。keyOf 需把分类、缺口原因、
// 传感器身份与校准版本都编进 key，保证合并不会跨越证据边界。
export function mergeAdjacent(intervals, keyOf) {
  const sorted = [...intervals].sort((a, b) => a.from - b.from || a.to - b.to);
  const out = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && last.to === iv.from && keyOf(last) === keyOf(iv)) {
      last.to = iv.to;
    } else {
      out.push({ ...iv });
    }
  }
  return out;
}

export function durationMs(iv) {
  return Math.max(0, iv.to - iv.from);
}

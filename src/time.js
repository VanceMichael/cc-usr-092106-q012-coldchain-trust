// 所有判定只使用 UTC 时刻；事件字符串里的时区偏移仅决定它归并到哪个 UTC 瞬间。
export function ms(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) {
    throw new Error(`无法解析时刻: ${iso}`);
  }
  return t;
}

export function iso(t) {
  return new Date(t).toISOString();
}

export function sortByTime(rows, getAt = (r) => r.from) {
  return [...rows].sort((a, b) => ms(getAt(a)) - ms(getAt(b)));
}

// 合并相交或首尾相接的区间。输入与输出均为 ISO 字符串区间 {from, to}。
export function mergeIntervals(intervals) {
  const sorted = sortByTime(intervals).map((i) => ({ from: ms(i.from), to: ms(i.to) }));
  const out = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv.from <= last.to) {
      if (iv.to > last.to) last.to = iv.to;
    } else {
      out.push({ ...iv });
    }
  }
  return out.map((i) => ({ from: iso(i.from), to: iso(i.to) }));
}

export function intersectIntervals(a, b) {
  const out = [];
  for (const x of a) {
    for (const y of b) {
      const from = Math.max(ms(x.from), ms(y.from));
      const to = Math.min(ms(x.to), ms(y.to));
      if (from < to) out.push({ from, to });
    }
  }
  return mergeIntervals(out.map((i) => ({ from: iso(i.from), to: iso(i.to) })));
}

// 返回 window 中未被 covered 覆盖的部分。
export function gapsWithin(window, covered) {
  const w = { from: ms(window.from), to: ms(window.to) };
  const cuts = mergeIntervals(covered)
    .map((i) => ({ from: ms(i.from), to: ms(i.to) }))
    .filter((i) => i.to > w.from && i.from < w.to);
  const out = [];
  let cursor = w.from;
  for (const c of cuts) {
    if (c.from > cursor) out.push({ from: cursor, to: Math.min(c.from, w.to) });
    cursor = Math.max(cursor, c.to);
    if (cursor >= w.to) break;
  }
  if (cursor < w.to) out.push({ from: cursor, to: w.to });
  return out.map((i) => ({ from: iso(i.from), to: iso(i.to) }));
}

// 用 IANA 时区展示时刻；判定永远不要用这个字符串，必须用 ms() 后的 UTC 瞬间。
export function displayInTimeZone(value, timeZone) {
  const d = new Date(ms(value));
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(d);
}

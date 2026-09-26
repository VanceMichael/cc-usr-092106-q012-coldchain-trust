// 批次血缘：多轮收购、拼箱、拆分之后，下游影响范围靠这张图还原。
// 边有两种：
//   - split_from（有向）：新批次从旧批次拆分而来，from -> to；
//   - shared_box（无向）：两个批次曾在同一箱体内同运（拼箱），互为暴露方。
// 边都带时间，追溯时只沿不早于放行证据窗口起点的边传播。

export function downstreamBatches(edges, startBatchId, sinceTs) {
  const found = new Set();
  const queue = [startBatchId];
  while (queue.length > 0) {
    const current = queue.pop();
    for (const edge of edges) {
      if (edge.ts < sinceTs) continue;
      let next = null;
      if (edge.type === 'split_from' && edge.from === current) {
        next = edge.to;
      } else if (edge.type === 'shared_box') {
        if (edge.a === current) next = edge.b;
        else if (edge.b === current) next = edge.a;
      }
      if (next != null && next !== startBatchId && !found.has(next)) {
        found.add(next);
        queue.push(next);
      }
    }
  }
  return [...found];
}

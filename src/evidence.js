// 证据索引：证据文件只追加、不就地修改；所有视图都从索引重新派生。
import { ms } from './time.js';

export function indexEvidence(pack) {
  const byId = (rows, key = 'id') => {
    const m = new Map();
    for (const r of rows || []) m.set(r[key], r);
    return m;
  };
  const events = [...pack.events].sort((a, b) => ms(a.at) - ms(b.at));
  return {
    raw: pack,
    sensors: byId(pack.sensors, 'sensor_id'),
    calibrations: byId(pack.calibrations, 'calibration_id'),
    containers: byId(pack.containers, 'container_id'),
    batches: byId(pack.batches, 'batch_id'),
    tasks: byId(pack.tasks, 'task_id'),
    parties: byId(pack.parties, 'party_id'),
    events,
    segments: [...pack.temperature_segments].sort((a, b) => ms(a.started_at) - ms(b.started_at)),
    rules: [...pack.quality_rules].sort((a, b) => ms(a.effective_from) - ms(b.effective_from)),
    dispositions: [...pack.dispositions].sort((a, b) => ms(a.at) - ms(b.at)),
    notifications: pack.notifications || []
  };
}

// 某时刻生效的质量规则版本。处置与放行必须固化当时命中的 rule_id/version。
export function ruleAt(idx, at) {
  const t = ms(at);
  let hit = null;
  for (const r of idx.rules) {
    if (ms(r.effective_from) <= t) hit = r;
  }
  if (!hit) throw new Error(`时刻 ${at} 没有生效的质量规则`);
  return hit;
}

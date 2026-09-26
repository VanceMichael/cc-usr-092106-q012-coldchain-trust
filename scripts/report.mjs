// 演示后台两个关键视图：接收方扫箱、质量负责人追查放行撤销。
// 用法：node scripts/report.mjs
import { readFile } from 'node:fs/promises';
import { scanContainer, revocationTrace, evaluateBatch, indexEvidence, replayContainment } from '../src/index.js';

const pack = JSON.parse(await readFile(new URL('../fixtures/evidence.json', import.meta.url), 'utf8'));
const line = '─'.repeat(72);

function showScan(containerId, at, tz) {
  const s = scanContainer(pack, containerId, at, tz);
  console.log(line);
  console.log(`扫描 ${containerId}（${s.container_kind}） @ ${s.scanned_at_local}  → 结论 ${s.verdict}`);
  if (s.looks_like_cold_chain_but_unverified) console.log('  ⚠ 外观像冷链（泡沫箱+铝箔纸），但箱体本身不提供任何温度证据');
  for (const b of s.batches) {
    console.log(`  批次 ${b.batch_id} ${b.product_name}  运输合规=${b.compliant} 放行状态=${b.release_status}`);
    for (const v of b.verified_intervals) console.log(`    可核验 ${v.from_local} → ${v.to_local}`);
    for (const g of b.gaps) console.log(`    缺口[${g.reason}] ${g.from_local} → ${g.to_local}（不插值）`);
    for (const x of b.excursions) console.log(`    超限 ${x.from.slice(11, 16)}–${x.to.slice(11, 16)}Z 峰值 ${x.max_c}°C`);
    if (b.inherited_revocation) console.log(`    ⚠ 上游批次 ${b.inherited_revocation.ancestor_batch_id} 已撤销：${b.inherited_revocation.reason}`);
    if (b.unsigned_handovers.length) console.log(`    ⚠ 存在 ${b.unsigned_handovers.length} 次无人签署交接`);
  }
}

showScan('CF', '2026-09-11T08:30:00Z', 'Asia/Shanghai');
showScan('C4', '2026-09-03T05:30:00Z', 'Europe/Berlin');

console.log(line);
const t = revocationTrace(pack, 'REL-001');
console.log(`质量负责人追查 ${t.release_entry}：${t.released_at} 由 ${t.release_signer} 按 ${t.rule_at_release.rule_id} v${t.rule_at_release.version} 放行`);
console.log(`  放行依据：可核验区间 ${t.release_basis.verified_intervals.length} 段，缺口 ${t.release_basis.gaps.length}，超限 ${t.release_basis.excursions.length}（当时只有压缩均值）`);
console.log(`  撤销条目 ${t.revocation_entry} @ ${t.revoked_at}，签署人 ${t.revocation_signer}`);
console.log(`  撤销原因：${t.revocation_reason}`);
console.log(`  晚到证据：${t.late_segments.join('、')}（旧放行条目哈希未被改写）`);
console.log(`  受影响下游：${t.affected_downstream_batches.join('、')}；仍待通知：${t.notifications_pending.map((p) => `${p.batch_id}@${p.current_holder}`).join('、') || '无'}`);

// 掉线批次的完整重算，证明缺口来自读点缺失而非任何填充
const idx = indexEvidence(pack);
const rp = replayContainment(idx);
const b4 = evaluateBatch(idx, rp, 'B4', '2026-09-05T13:00:00Z');
console.log(line);
console.log(`B4 隔离依据：缺口 ${b4.gaps.map((g) => `${g.from.slice(11, 16)}–${g.to.slice(11, 16)}Z[${g.reason}]`).join('、')}，合规=${b4.compliant}`);

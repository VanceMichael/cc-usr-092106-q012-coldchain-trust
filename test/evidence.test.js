import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  indexEvidence,
  replayContainment,
  evaluateBatch,
  verifyLedger,
  releaseStatus,
  scanContainer,
  revocationTrace,
  downstreamToNotify,
  custodyTrail,
  descendants
} from '../src/index.js';
import { validate } from '../src/validate.js';
import { gapsWithin, mergeIntervals } from '../src/time.js';

const load = async () => JSON.parse(await readFile(new URL('../fixtures/evidence.json', import.meta.url), 'utf8'));
const schema = JSON.parse(await readFile(new URL('../contracts/evidence.schema.json', import.meta.url), 'utf8'));

test('证据包符合契约', async () => {
  const pack = await load();
  assert.deepEqual(validate(schema, pack), []);
});

test('区间工具：缺口只标记、不生成任何读数', () => {
  const gaps = gapsWithin({ from: '2026-01-01T00:00:00Z', to: '2026-01-01T10:00:00Z' }, [
    { from: '2026-01-01T00:00:00Z', to: '2026-01-01T02:00:00Z' },
    { from: '2026-01-01T08:00:00Z', to: '2026-01-01T10:00:00Z' }
  ]);
  assert.deepEqual(gaps, [{ from: '2026-01-01T02:00:00.000Z', to: '2026-01-01T08:00:00.000Z' }]);
  assert.deepEqual(mergeIntervals([
    { from: '2026-01-01T01:00:00Z', to: '2026-01-01T03:00:00Z' },
    { from: '2026-01-01T02:00:00Z', to: '2026-01-01T04:00:00Z' }
  ]).map((i) => `${i.from}/${i.to}`), ['2026-01-01T01:00:00.000Z/2026-01-01T04:00:00.000Z']);
});

test('设备掉线：B4 存在与实际掉线一致的缺口，带缺口不合规且永不放行', async () => {
  const pack = await load();
  const idx = indexEvidence(pack);
  const rp = replayContainment(idx);
  const e = evaluateBatch(idx, rp, 'B4', '2026-09-05T13:00:00Z');
  assert.equal(e.compliant, false);
  assert.equal(e.gaps.length, 1);
  assert.equal(e.gaps[0].reason, 'sensor_offline');
  assert.equal(e.gaps[0].from, '2026-09-05T05:00:00.000Z');
  assert.equal(e.gaps[0].to, '2026-09-05T09:00:00.000Z');
  // 缺口区间内没有任何样本被用来作证
  const seg = pack.temperature_segments.find((s) => s.segment_id === 'SEG-S6-GAP');
  const inGap = seg.samples.filter((s) => new Date(s.t) > new Date('2026-09-05T05:00:00Z') && new Date(s.t) < new Date('2026-09-05T09:00:00Z'));
  assert.equal(inGap.length, 0);
  assert.equal(releaseStatus(pack, 'B4', pack.generated_at).status, 'never_released');
  // 处置必须引用当时规则版本与签署人
  const d = pack.dispositions.find((x) => x.disposition_id === 'D-001');
  assert.equal(d.action, 'quarantine');
  assert.equal(d.rule_version, 1);
  assert.ok(d.signer);
});

test('晚到数据不回写放行：REL-001 依据的片段集合不含次日才上传的缓存片段', async () => {
  const pack = await load();
  const rel = pack.release_ledger.find((e) => e.entry_id === 'REL-001');
  assert.equal(rel.decision, 'released');
  assert.ok(!rel.basis.segments_used.includes('SEG-S1-BUFFERED-LATE'));
  assert.deepEqual(rel.basis.excursions, []);
  assert.equal(rel.basis.data_complete, true);
});

test('同一旅程：放行时合规，晚到高清片段到达后重算揭示37分钟超限', async () => {
  const pack = await load();
  const idx = indexEvidence(pack);
  const rp = replayContainment(idx);
  const before = evaluateBatch(idx, rp, 'B1', '2026-09-02T07:00:00Z');
  assert.equal(before.compliant, true);
  assert.equal(before.excursion_minutes, 0);
  const after = evaluateBatch(idx, rp, 'B1', '2026-09-03T04:00:00Z');
  assert.equal(after.compliant, false);
  assert.ok(after.excursion_minutes >= 35, `应揭示约37分钟超限，实际 ${after.excursion_minutes}`);
  assert.ok(after.excursions[0].max_c > 12, '应以秒级原始读数而非6.4°C均值判定');
});

test('撤销只追加：哈希链可验算，任何旧条目被改写都会被检出', async () => {
  const pack = await load();
  assert.equal(verifyLedger(pack.release_ledger).ok, true);
  const originalHash = pack.release_ledger[0].entry_hash;

  const tampered = JSON.parse(JSON.stringify(pack.release_ledger));
  tampered[0].basis.excursions.push({ batch_id: 'B1', from: 'x', to: 'y', max_c: 99 });
  const r1 = verifyLedger(tampered);
  assert.equal(r1.ok, false);
  assert.equal(r1.tampered_entry, 'REL-001');

  // 旧条目本身字节不变
  assert.equal(pack.release_ledger[0].entry_hash, originalHash);
  const rev = pack.release_ledger.find((e) => e.entry_id === 'REL-002');
  assert.equal(rev.kind, 'revocation');
  assert.equal(rev.supersedes_entry_id, 'REL-001');
  assert.deepEqual(rev.new_segments, ['SEG-S1-BUFFERED-LATE']);
});

test('跨时区：带偏移时刻按 UTC 归并，10:20Z 的开门事件不被本地写法掩盖', async () => {
  const pack = await load();
  const open = pack.events.find((e) => e.event_id === 'E-DO-2O');
  assert.equal(new Date(open.at).toISOString(), '2026-09-01T10:20:00.000Z');
  // 晚到片段揭示的超限覆盖开门时段（开门 10:20Z，首个高读数 10:21Z）
  const idx = indexEvidence(pack);
  const rp = replayContainment(idx);
  const e = evaluateBatch(idx, rp, 'B1', '2026-09-03T04:00:00Z');
  assert.ok(e.excursions[0].from <= '2026-09-01T10:21:00.000Z');
  assert.ok(e.excursions[0].to >= '2026-09-01T10:56:00.000Z');
});

test('换箱与拼箱：B1 的冷藏车腿与保温箱腿分别封口，B2 不继承换箱前的开门超限', async () => {
  const pack = await load();
  const idx = indexEvidence(pack);
  const rp = replayContainment(idx);
  const b1 = rp.batchIntervals.get('B1').map((i) => `${i.containerId}:${i.from.slice(11, 16)}→${i.to.slice(11, 16)}`);
  assert.ok(b1.some((x) => x.startsWith('C1:')));
  assert.ok(b1.some((x) => x.startsWith('C2:')));
  // 换箱边界
  const c1 = rp.batchIntervals.get('B1').find((i) => i.containerId === 'C1');
  const c2 = rp.batchIntervals.get('B1').find((i) => i.containerId === 'C2');
  assert.equal(c1.to, c2.from);
  // B2 18:00 才拼入 C2，10:20 的超限与其无关
  const e2 = evaluateBatch(idx, rp, 'B2', '2026-09-02T07:00:00Z');
  assert.equal(e2.compliant, true);
  assert.equal(e2.excursion_minutes, 0);
});

test('拆分：父子谱系建立，子批次责任链从拆分点续接而非凭空开始', async () => {
  const pack = await load();
  const idx = indexEvidence(pack);
  const rp = replayContainment(idx);
  assert.deepEqual(descendants(rp, 'B1').map((d) => d.batch_id).sort(), ['B1-A', 'B1-B']);
  const trail = custodyTrail(idx, rp, 'B1-B');
  assert.equal(trail[0].party_name, '莱茵医药分销');
  assert.equal(trail[0].from, '2026-09-02T06:30:00.000Z');
  assert.equal(trail.at(-1).party_name, '河畔社区诊所');
  // 父批次在拆分后不再作为当前持有者
  assert.ok(new Date(trail[0].to) > new Date('2026-09-02T06:30:00Z'));
});

test('撤销追查：能还原为何撤销、晚到证据、以及仍需通知的下游批次', async () => {
  const pack = await load();
  const t = revocationTrace(pack, 'REL-001');
  assert.equal(t.revoked, true);
  assert.equal(t.revocation_reason.includes('晚到'), true);
  assert.deepEqual(t.affected_downstream_batches.sort(), ['B1-A', 'B1-B']);
  // B1-A 已确认不再待通知，B1-B 仍 pending
  assert.deepEqual(t.notifications_pending.map((n) => n.batch_id), ['B1-B']);
  const pending = downstreamToNotify(pack, 'B1', pack.generated_at);
  assert.equal(pending[0].current_holder, '河畔社区诊所');
});

test('泡沫箱伪装：无传感器即整段 no_sensor 缺口，存在无人签署交接，扫描拒收', async () => {
  const pack = await load();
  const idx = indexEvidence(pack);
  const rp = replayContainment(idx);
  const e = evaluateBatch(idx, rp, 'B3', '2026-09-11T09:00:00Z');
  assert.equal(e.compliant, false);
  assert.ok(e.gaps.every((g) => g.reason === 'no_sensor'));
  assert.ok(e.gaps.length >= 1);
  assert.ok(e.unsigned_handovers.length >= 1);
  const s = scanContainer(pack, 'CF', '2026-09-11T08:30:00Z', 'Asia/Shanghai');
  assert.equal(s.looks_like_cold_chain_but_unverified, true);
  assert.equal(s.verdict, 'hold');
});

test('接收方扫描：放行后可接收；撤销次日同箱扫描显示继承自 B1 的撤销', async () => {
  const pack = await load();
  const ok = scanContainer(pack, 'C4', '2026-09-02T15:00:00Z', 'Europe/Berlin');
  assert.equal(ok.verdict, 'received_clear');
  const held = scanContainer(pack, 'C4', '2026-09-03T05:30:00Z', 'Europe/Berlin');
  assert.equal(held.verdict, 'received_hold');
  assert.equal(held.batches[0].inherited_revocation.ancestor_batch_id, 'B1');
});

test('规则版本：9月运输始终适用 v1，未来 v2 不得溯及既往', async () => {
  const pack = await load();
  const idx = indexEvidence(pack);
  const rp = replayContainment(idx);
  const e = evaluateBatch(idx, rp, 'B1', '2026-09-03T04:00:00Z');
  assert.deepEqual(e.rule, { rule_id: 'QR-COLD', version: 1 });
  const v2 = pack.quality_rules.find((r) => r.version === 2);
  assert.ok(new Date(v2.effective_from) > new Date(pack.generated_at));
});

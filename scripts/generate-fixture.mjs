// 生成贯穿剧情的证据包：node scripts/generate-fixture.mjs > fixtures/evidence.json
// 剧情：B1/B2 北京→法兰克福（跨时区、换箱、拼箱、拆分为 B1-A/B1-B）；
// 实时压缩上报漏掉一次开门超限，晚到的缓存高清片段在放行后到达 → 只追加撤销并通知下游；
// B4 运输中传感器掉线形成缺口 → 隔离、永不放行；B3 泡沫箱加铝箔纸无证据流转 → 接收方拒收。
import { buildLedger } from '../src/index.js';

const RULE = {
  rule_id: 'QR-COLD',
  version: 1,
  effective_from: '2026-01-01T00:00:00Z',
  min_c: 2,
  max_c: 8,
  max_excursion_minutes: 15,
  gap_policy: 'mark_noncompliant',
  release_allowed_with_gap: false,
  text: '2–8°C 冷链；超限累计超过15分钟即不合规；任何无数据时段标记为缺口，禁止插值，带缺口不得放行。'
};
const RULE_V2 = {
  ...RULE,
  version: 2,
  effective_from: '2026-10-01T00:00:00Z',
  max_excursion_minutes: 30,
  text: '未来版本（放宽至30分钟），不得溯及既往适用于9月的运输与处置。'
};

const parties = [
  ['P-MFG', '华北生物制药', 'manufacturer'],
  ['P-CAR', '洲际冷链', 'carrier'],
  ['P-HUB', '法兰克福分拨中心', 'hub'],
  ['P-DIST', '莱茵医药分销', 'distributor'],
  ['P-PHA', '城市药房', 'pharmacy'],
  ['P-CLI', '河畔社区诊所', 'clinic'],
  ['P-GANG', '无牌收购人', 'unlicensed'],
  ['P-CLI2', '益康诊所', 'clinic']
].map(([party_id, name, role]) => ({ party_id, name, role }));

const containers = [
  { container_id: 'C1', kind: 'reefer', seal_id: 'SEAL-C1-001', note: '北京发车冷藏车' },
  { container_id: 'C2', kind: 'insulated_box', seal_id: 'SEAL-C2-009', note: '法兰克福中转被动保温箱' },
  { container_id: 'C3', kind: 'passive_pack', seal_id: 'SEAL-C3-002', note: '配送城市药房' },
  { container_id: 'C4', kind: 'passive_pack', seal_id: 'SEAL-C4-002', note: '配送社区诊所' },
  { container_id: 'C5', kind: 'reefer', seal_id: 'SEAL-C5-007', note: '疫苗冷藏车（中途掉线）' },
  { container_id: 'CF', kind: 'foam_wrapped', seal_id: null, note: '泡沫箱加铝箔纸，外观像冷链，无任何温控设备' }
];

const batches = [
  { batch_id: 'B1', product_name: '重组人胰岛素注射液', initial_quantity: 100, unit: '支', manufacture_date: '2026-08-10' },
  { batch_id: 'B2', product_name: '静注人免疫球蛋白', initial_quantity: 40, unit: '瓶', manufacture_date: '2026-08-20' },
  { batch_id: 'B1-A', product_name: '重组人胰岛素注射液（拆分配额60）', initial_quantity: 60, unit: '支', manufacture_date: '2026-08-10' },
  { batch_id: 'B1-B', product_name: '重组人胰岛素注射液（拆分配额40）', initial_quantity: 40, unit: '支', manufacture_date: '2026-08-10' },
  { batch_id: 'B4', product_name: '狂犬疫苗', initial_quantity: 30, unit: '支', manufacture_date: '2026-08-25' },
  { batch_id: 'B3', product_name: '人血白蛋白（来源不明）', initial_quantity: 20, unit: '瓶', manufacture_date: '2026-07-01' }
];

const sensors = [
  ['S1', 'HW-S1-7781', 'AKID-S1'],
  ['S2', 'HW-S2-3320', 'AKID-S2'],
  ['S4', 'HW-S4-1198', 'AKID-S4'],
  ['S5', 'HW-S5-1205', 'AKID-S5'],
  ['S6', 'HW-S6-6641', 'AKID-S6']
].map(([sensor_id, hw_serial, attestation_key_id]) => ({ sensor_id, hw_serial, attestation_key_id, model: 'TL-200' }));

const calibrations = sensors.map((s, i) => ({
  calibration_id: `CAL-${s.sensor_id}`,
  sensor_id: s.sensor_id,
  kind: 'initial',
  valid_from: '2026-01-10T00:00:00Z',
  valid_to: null,
  bias_c: 0,
  max_uncertainty_c: 0.3,
  calibrated_by: 'METRO-LAB',
  certificate_ref: `CERT-2026-${110 + i}`,
  corrects_calibration_id: null
}));

const tasks = [
  {
    task_id: 'T1', carrier_party_id: 'P-CAR',
    temp_spec: { min_c: 2, max_c: 8 },
    route: [{ location: '北京', tz: 'Asia/Shanghai' }, { location: '法兰克福', tz: 'Europe/Berlin' }]
  },
  {
    task_id: 'T2', carrier_party_id: 'P-DIST',
    temp_spec: { min_c: 2, max_c: 8 },
    route: [{ location: '法兰克福', tz: 'Europe/Berlin' }, { location: '美因茨', tz: 'Europe/Berlin' }]
  },
  { task_id: 'T3', carrier_party_id: 'P-DIST', temp_spec: { min_c: 2, max_c: 8 }, route: [{ location: '美因茨', tz: 'Europe/Berlin' }, { location: '城市药房', tz: 'Europe/Berlin' }] },
  { task_id: 'T4', carrier_party_id: 'P-DIST', temp_spec: { min_c: 2, max_c: 8 }, route: [{ location: '美因茨', tz: 'Europe/Berlin' }, { location: '河畔社区诊所', tz: 'Europe/Berlin' }] },
  { task_id: 'T5', carrier_party_id: 'P-CAR', temp_spec: { min_c: 2, max_c: 8 }, route: [{ location: '北京', tz: 'Asia/Shanghai' }, { location: '西安', tz: 'Asia/Shanghai' }] }
];

const events = [];
const ev = (o) => events.push({ task_id: null, location: null, from_party: null, to_party: null, container_id: null, from_container_id: null, batch_ids: [], outputs: [], sensor_id: null, seal_id: null, note: null, ...o });

// —— B1 冷藏车腿：北京 09-01 01:05Z（当地09:05）发车 ——
ev({ event_id: 'E-ATT-S1', at: '2026-09-01T01:00:00Z', type: 'attach', container_id: 'C1', sensor_id: 'S1', location: '北京', signed_by: 'EMP-WH-01' });
ev({ event_id: 'E-PACK-B1', at: '2026-09-01T01:05:00Z', type: 'pack', task_id: 'T1', location: '北京', from_party: 'P-MFG', container_id: 'C1', batch_ids: ['B1'], seal_id: 'SEAL-C1-001', signed_by: 'EMP-WH-01' });
ev({ event_id: 'E-HO-1', at: '2026-09-01T01:12:00Z', type: 'handover', task_id: 'T1', location: '北京', from_party: 'P-MFG', to_party: 'P-CAR', container_id: 'C1', batch_ids: ['B1'], signed_by: 'EMP-DRV-01' });
ev({ event_id: 'E-DO-1O', at: '2026-09-01T01:15:00Z', type: 'door_open', task_id: 'T1', container_id: 'C1', signed_by: 'EMP-DRV-01' });
ev({ event_id: 'E-DO-1C', at: '2026-09-01T01:18:00Z', type: 'door_close', task_id: 'T1', container_id: 'C1', signed_by: 'EMP-DRV-01' });
// 中途停机开箱：用带偏移的本地时刻书写，12:20+02:00 归并为 10:20Z，展示跨时区归并
ev({ event_id: 'E-DO-2O', at: '2026-09-01T12:20:00+02:00', type: 'door_open', task_id: 'T1', location: '中转停机坪（当地12:20）', container_id: 'C1', signed_by: 'EMP-DRV-01' });
ev({ event_id: 'E-DO-2C', at: '2026-09-01T11:00:00Z', type: 'door_close', task_id: 'T1', location: '中转停机坪', container_id: 'C1', signed_by: 'EMP-DRV-01' });

// —— 法兰克福换箱、拼箱 ——
ev({ event_id: 'E-ATT-S2', at: '2026-09-01T13:50:00Z', type: 'attach', container_id: 'C2', sensor_id: 'S2', location: '法兰克福', signed_by: 'EMP-HUB-02' });
ev({ event_id: 'E-REPACK-B1', at: '2026-09-01T14:00:00Z', type: 'repack', task_id: 'T1', location: '法兰克福', from_party: 'P-CAR', container_id: 'C2', from_container_id: 'C1', batch_ids: ['B1'], seal_id: 'SEAL-C2-009', signed_by: 'EMP-HUB-02' });
ev({ event_id: 'E-DET-S1', at: '2026-09-01T14:00:00Z', type: 'detach', container_id: 'C1', sensor_id: 'S1', signed_by: 'EMP-HUB-02' });
ev({ event_id: 'E-HO-2', at: '2026-09-01T14:10:00Z', type: 'handover', task_id: 'T1', location: '法兰克福', from_party: 'P-CAR', to_party: 'P-HUB', container_id: 'C2', batch_ids: ['B1'], signed_by: 'EMP-HUB-02' });
// 拼箱：B2 在枢纽直接装入与 B1 同一保温箱（10:20Z 的开门超限发生在 C1，B2 不在场）
ev({ event_id: 'E-PACK-B2', at: '2026-09-01T18:00:00Z', type: 'pack', task_id: 'T2', location: '法兰克福', from_party: 'P-HUB', container_id: 'C2', batch_ids: ['B2'], signed_by: 'EMP-HUB-02' });
ev({ event_id: 'E-HO-3', at: '2026-09-02T06:00:00Z', type: 'handover', task_id: 'T2', location: '美因茨', from_party: 'P-HUB', to_party: 'P-DIST', container_id: 'C2', batch_ids: ['B1', 'B2'], signed_by: 'EMP-DST-03' });
ev({ event_id: 'E-UNPACK-B2', at: '2026-09-02T06:30:00Z', type: 'unpack', task_id: 'T2', location: '美因茨', container_id: 'C2', batch_ids: ['B2'], signed_by: 'EMP-DST-03', note: 'B2 入库受控冰箱' });

// —— 拆分：B1 → B1-A(60)/B1-B(40)，各自新箱新传感器 ——
ev({ event_id: 'E-ATT-S4', at: '2026-09-02T06:20:00Z', type: 'attach', container_id: 'C3', sensor_id: 'S4', signed_by: 'EMP-DST-03' });
ev({ event_id: 'E-ATT-S5', at: '2026-09-02T06:20:00Z', type: 'attach', container_id: 'C4', sensor_id: 'S5', signed_by: 'EMP-DST-03' });
ev({
  event_id: 'E-SPLIT-B1', at: '2026-09-02T06:30:00Z', type: 'split', task_id: 'T2', location: '美因茨',
  container_id: 'C2', batch_ids: ['B1'],
  outputs: [
    { batch_id: 'B1-A', container_id: 'C3', quantity: 60 },
    { batch_id: 'B1-B', container_id: 'C4', quantity: 40 }
  ],
  signed_by: 'EMP-DST-03'
});
ev({ event_id: 'E-HO-4', at: '2026-09-02T12:00:00Z', type: 'handover', task_id: 'T3', location: '城市药房', from_party: 'P-DIST', to_party: 'P-PHA', container_id: 'C3', batch_ids: ['B1-A'], signed_by: 'EMP-PHA-09' });
ev({ event_id: 'E-RCP-A', at: '2026-09-02T12:30:00Z', type: 'receipt', task_id: 'T3', location: '城市药房', to_party: 'P-PHA', container_id: 'C3', batch_ids: ['B1-A'], signed_by: 'EMP-PHA-09' });
ev({ event_id: 'E-UNPACK-A', at: '2026-09-02T13:00:00Z', type: 'unpack', task_id: 'T3', container_id: 'C3', batch_ids: ['B1-A'], signed_by: 'EMP-PHA-09', note: '放行核验通过后入库' });
ev({ event_id: 'E-HO-5', at: '2026-09-02T13:00:00Z', type: 'handover', task_id: 'T4', location: '河畔社区诊所', from_party: 'P-DIST', to_party: 'P-CLI', container_id: 'C4', batch_ids: ['B1-B'], signed_by: 'EMP-CLI-07' });
ev({ event_id: 'E-RCP-B', at: '2026-09-02T13:30:00Z', type: 'receipt', task_id: 'T4', location: '河畔社区诊所', to_party: 'P-CLI', container_id: 'C4', batch_ids: ['B1-B'], signed_by: 'EMP-CLI-07' });
// 诊所收货后整箱暂存不拆箱；次日凌晨撤销通知到达，直接整箱封存，扫描仍能查到箱内批次与继承的撤销警示。

// —— B4：传感器 05:00 后掉线，09:00 才恢复；缺口不得被相邻读数填平 ——
ev({ event_id: 'E-ATT-S6', at: '2026-09-05T02:00:00Z', type: 'attach', container_id: 'C5', sensor_id: 'S6', signed_by: 'EMP-WH-01' });
ev({ event_id: 'E-PACK-B4', at: '2026-09-05T02:00:00Z', type: 'pack', task_id: 'T5', location: '北京', from_party: 'P-MFG', container_id: 'C5', batch_ids: ['B4'], seal_id: 'SEAL-C5-007', signed_by: 'EMP-WH-01' });
ev({ event_id: 'E-HO-6', at: '2026-09-05T02:05:00Z', type: 'handover', task_id: 'T5', from_party: 'P-MFG', to_party: 'P-CAR', container_id: 'C5', batch_ids: ['B4'], signed_by: 'EMP-DRV-02' });
ev({ event_id: 'E-RCP-B4', at: '2026-09-05T12:00:00Z', type: 'receipt', task_id: 'T5', location: '西安', to_party: 'P-CLI2', container_id: 'C5', batch_ids: ['B4'], signed_by: 'EMP-CLI2-01' });
ev({ event_id: 'E-UNPACK-B4', at: '2026-09-05T12:00:00Z', type: 'unpack', task_id: 'T5', container_id: 'C5', batch_ids: ['B4'], signed_by: 'EMP-CLI2-01' });

// —— B3：泡沫箱加铝箔纸，无传感器，多轮收购，交接无人签署 ——
ev({ event_id: 'E-PACK-B3', at: '2026-09-10T03:00:00Z', type: 'pack', location: '城郊仓库', from_party: 'P-GANG', container_id: 'CF', batch_ids: ['B3'], signed_by: null, note: '无人签署的装箱' });
ev({ event_id: 'E-HO-7', at: '2026-09-10T15:00:00Z', type: 'handover', location: '高速服务区', from_party: 'P-GANG', to_party: 'P-GANG', container_id: 'CF', batch_ids: ['B3'], signed_by: null, note: '多轮收购之一，责任链断裂' });
ev({ event_id: 'E-RCP-B3', at: '2026-09-11T09:00:00Z', type: 'receipt', location: '益康诊所', to_party: 'P-CLI2', container_id: 'CF', batch_ids: ['B3'], signed_by: 'EMP-CLI2-01' });

// —— 温度片段 ——
const every = (startIso, endIso, min, fn) => {
  const step = min * 60000;
  const t0 = Date.parse(startIso);
  const t1 = Date.parse(endIso);
  const out = [];
  for (let t = t0; t <= t1; t += step) out.push({ t: new Date(t).toISOString(), c: Number(fn(t).toFixed(2)) });
  return out;
};

const seg1Samples = every('2026-09-01T01:05:00Z', '2026-09-01T14:00:00Z', 15, (t) => {
  let c = 5.2 + Math.sin(t / 3600000) * 0.7;
  const h = new Date(t).toISOString().slice(11, 16);
  // 15 分钟压缩均值把 10:21–10:56 的开门峰值抹平成轻微抬升
  if (['10:30', '10:45'].includes(h)) c = 6.4;
  return c;
});
// 晚到的缓存高清片段：60 秒原始读数，揭示约35分钟 >8°C 的真实超限
const lateSamples = every('2026-09-01T10:19:00Z', '2026-09-01T10:58:00Z', 1, (t) => {
  const min = new Date(t).getMinutes() + new Date(t).getSeconds() / 60;
  if (t < Date.parse('2026-09-01T10:21:00Z')) return 6 + (t - Date.parse('2026-09-01T10:19:00Z')) / 120000;
  if (t <= Date.parse('2026-09-01T10:56:00Z')) return 13.1 + Math.sin(min) * 0.25;
  return 13 - (t - Date.parse('2026-09-01T10:56:00Z')) / 120000;
}).map((s) => ({ t: s.t, c: Number(s.c.toFixed(2)) }));

const temperature_segments = [
  {
    segment_id: 'SEG-S1-REALTIME', sensor_id: 'S1', calibration_id: 'CAL-S1',
    started_at: '2026-09-01T01:05:00Z', ended_at: '2026-09-01T14:00:00Z', interval_s: 900,
    samples: seg1Samples, uploaded_at: '2026-09-01T14:05:00Z', transmission: 'realtime', status: 'active', corrected_by: null,
    note: '实时压缩上报，15分钟均值，峰值被平均掩盖'
  },
  {
    segment_id: 'SEG-S1-BUFFERED-LATE', sensor_id: 'S1', calibration_id: 'CAL-S1',
    started_at: '2026-09-01T10:19:00Z', ended_at: '2026-09-01T10:58:00Z', interval_s: 60,
    samples: lateSamples, uploaded_at: '2026-09-03T02:00:00Z', transmission: 'buffered_late', status: 'active', corrected_by: null,
    note: '设备回库后导出的缓存原始日志，晚于放行到达，不得回写旧结论'
  },
  {
    segment_id: 'SEG-S2', sensor_id: 'S2', calibration_id: 'CAL-S2',
    started_at: '2026-09-01T14:00:00Z', ended_at: '2026-09-02T06:30:00Z', interval_s: 900,
    samples: every('2026-09-01T14:00:00Z', '2026-09-02T06:30:00Z', 15, (t) => 5 + Math.sin(t / 7200000) * 0.6),
    uploaded_at: '2026-09-02T06:45:00Z', transmission: 'realtime', status: 'active', corrected_by: null
  },
  {
    segment_id: 'SEG-S4', sensor_id: 'S4', calibration_id: 'CAL-S4',
    started_at: '2026-09-02T06:30:00Z', ended_at: '2026-09-02T12:30:00Z', interval_s: 900,
    samples: every('2026-09-02T06:30:00Z', '2026-09-02T12:30:00Z', 15, (t) => 5.4 + Math.sin(t / 5400000) * 0.5),
    uploaded_at: '2026-09-02T12:40:00Z', transmission: 'realtime', status: 'active', corrected_by: null
  },
  {
    segment_id: 'SEG-S5', sensor_id: 'S5', calibration_id: 'CAL-S5',
    started_at: '2026-09-02T06:30:00Z', ended_at: '2026-09-02T13:30:00Z', interval_s: 900,
    samples: every('2026-09-02T06:30:00Z', '2026-09-02T13:30:00Z', 15, (t) => 5.1 + Math.sin(t / 5400000) * 0.5),
    uploaded_at: '2026-09-02T13:40:00Z', transmission: 'realtime', status: 'active', corrected_by: null
  },
  {
    // 02:00–05:00 连续，下一个读点直接跳到 09:00：中间 05:15–09:00 为掉线缺口
    segment_id: 'SEG-S6-GAP', sensor_id: 'S6', calibration_id: 'CAL-S6',
    started_at: '2026-09-05T02:00:00Z', ended_at: '2026-09-05T12:00:00Z', interval_s: 900,
    samples: [
      ...every('2026-09-05T02:00:00Z', '2026-09-05T05:00:00Z', 15, (t) => 5.3 + Math.sin(t / 3600000) * 0.4),
      ...every('2026-09-05T09:00:00Z', '2026-09-05T12:00:00Z', 15, (t) => 5.6 + Math.sin(t / 3600000) * 0.4)
    ],
    uploaded_at: '2026-09-05T12:15:00Z', transmission: 'realtime', status: 'active', corrected_by: null,
    note: '05:00 后设备断电掉线，09:00 恢复，缺失读点未补'
  }
];

const dispositions = [
  {
    disposition_id: 'D-001', at: '2026-09-05T13:00:00Z', batch_ids: ['B4'], action: 'quarantine',
    reason: '05:15–09:00 UTC 传感器掉线，存在3小时45分无数据缺口，按规则带缺口不得放行，先行隔离待查',
    rule_id: 'QR-COLD', rule_version: 1, signer: 'EMP-QL-01',
    based_on_segments: ['SEG-S6-GAP'], based_on_release_entry: null
  },
  {
    disposition_id: 'D-002', at: '2026-09-03T04:30:00Z', batch_ids: ['B1'], action: 'reject',
    reason: '晚到缓存片段显示运输途中开门后约35分钟 >8°C，超过15分钟限值；原放行所据实时均值数据不完整，整批报废',
    rule_id: 'QR-COLD', rule_version: 1, signer: 'EMP-QL-01',
    based_on_segments: ['SEG-S1-BUFFERED-LATE'], based_on_release_entry: 'REL-001'
  },
  {
    disposition_id: 'D-003', at: '2026-09-11T09:30:00Z', batch_ids: ['B3'], action: 'reject',
    reason: '泡沫箱加铝箔纸无温控设备、无任何温度证据，且存在无人签署交接，全程不可核验，拒收并上报',
    rule_id: 'QR-COLD', rule_version: 1, signer: 'EMP-CLI2-01',
    based_on_segments: [], based_on_release_entry: null
  }
];

const pack = {
  domain: 'coldchain-trust',
  schema_version: 1,
  generated_at: '2026-09-12T00:00:00Z',
  sensors,
  calibrations,
  containers,
  batches,
  tasks,
  parties,
  events,
  temperature_segments,
  quality_rules: [RULE, RULE_V2],
  dispositions,
  release_ledger: [],
  notifications: []
};

// 放行账本（哈希链由领域逻辑计算）：先放行，下游各自放行，晚到证据到达后只追加撤销。
pack.release_ledger = buildLedger(pack, [
  { entry_id: 'REL-001', at: '2026-09-02T07:00:00Z', intent: 'release', batch_ids: ['B1', 'B2'], signer: 'EMP-QL-01', reason: '到货核验：当时已上传片段全程2–8°C、无缺口' },
  { entry_id: 'REL-003', at: '2026-09-02T12:45:00Z', intent: 'release', batch_ids: ['B1-A'], signer: 'EMP-QL-01', reason: '拆分后城市药房收货，配送段数据全程合规' },
  { entry_id: 'REL-004', at: '2026-09-02T13:45:00Z', intent: 'release', batch_ids: ['B1-B'], signer: 'EMP-QL-01', reason: '拆分后社区诊所收货，配送段数据全程合规' },
  { entry_id: 'REL-002', at: '2026-09-03T04:00:00Z', intent: 'revoke', batch_ids: ['B1'], signer: 'EMP-QL-01', supersedes_entry_id: 'REL-001', new_segments: ['SEG-S1-BUFFERED-LATE'], reason: '晚到的缓存原始日志揭示35分钟超限，原放行依据不完整；撤销B1原放行并追查下游' }
]);

pack.notifications = [
  {
    notification_id: 'N-001', revocation_entry_id: 'REL-002', batch_id: 'B1-A',
    downstream_party_id: 'P-PHA', status: 'acked', sent_at: '2026-09-03T05:00:00Z', acked_at: '2026-09-03T06:10:00Z'
  },
  {
    notification_id: 'N-002', revocation_entry_id: 'REL-002', batch_id: 'B1-B',
    downstream_party_id: 'P-CLI', status: 'pending', sent_at: '2026-09-03T05:00:00Z', acked_at: null
  }
];

process.stdout.write(JSON.stringify(pack, null, 2));

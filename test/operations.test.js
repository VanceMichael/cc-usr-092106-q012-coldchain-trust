// 箱操作与责任链：换箱、拼箱、拆分、设备掉线、跨时区交接都要保留实际责任段。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, setupColdBox, T0, MIN, HOUR } from './helpers.js';

test('换箱后批次证据链跨箱连续，两段责任分别保留', () => {
  const world = makeWorld();
  const { commands, queries, state } = world;
  setupColdBox(commands);
  commands.registerBox({ boxId: 'BOX-2', holder: '承运乙', ts: T0 });
  commands.createTask({ taskId: 'TASK-1', carrier: '冷链快运' });
  commands.attachBoxToTask({ taskId: 'TASK-1', boxId: 'BOX-1', from: T0 + HOUR, to: T0 + 2 * HOUR });
  commands.recordHandover({
    boxId: 'BOX-1',
    fromHolder: '仓库甲',
    toHolder: '司机丙',
    ts: T0 + HOUR,
    handlers: { from: '仓管员A', to: '司机丙' },
    taskId: 'TASK-1',
  });
  commands.rebox({ batchId: 'LOT-1', toBoxId: 'BOX-2', ts: T0 + 2 * HOUR, reason: '原箱制冷故障' });
  commands.recordHandover({ boxId: 'BOX-2', fromHolder: '承运乙', toHolder: '收货仓', ts: T0 + 3 * HOUR });

  const evidence = queries.batchEvidence(state, 'LOT-1', { from: T0, to: T0 + 4 * HOUR });
  assert.equal(evidence.parts.length, 2);
  assert.deepEqual(
    evidence.parts.map((p) => [p.boxId, p.via]),
    [
      ['BOX-1', 'initial'],
      ['BOX-2', 'rebox'],
    ],
  );
  // 第一段：仓库甲 → 司机丙（带承运任务）；第二段：承运乙 → 收货仓
  const [first, second] = evidence.parts;
  assert.deepEqual(
    first.holders.map((h) => h.holder),
    ['仓库甲', '司机丙'],
  );
  assert.equal(first.holders[1].carrier, '冷链快运');
  assert.deepEqual(
    second.holders.map((h) => h.holder),
    ['承运乙', '收货仓'],
  );
  assert.deepEqual(evidence.boxesInvolved.sort(), ['BOX-1', 'BOX-2']);
});

test('拼箱在同运批次间留下 shared_box 血缘边', () => {
  const world = makeWorld();
  const { commands, state } = world;
  setupColdBox(commands);
  commands.registerBox({ boxId: 'BOX-2', holder: '承运乙', ts: T0 });
  commands.registerBatch({ batchId: 'LOT-2', product: '疫苗Y', lot: 'L002', ruleId: 'cold-2-8', ruleVersion: 1 });
  commands.consolidate({ batchIds: ['LOT-1', 'LOT-2'], boxId: 'BOX-2', ts: T0 + HOUR });
  const edge = state.lineageEdges.find((e) => e.type === 'shared_box');
  assert.ok(edge);
  assert.deepEqual([edge.a, edge.b].sort(), ['LOT-1', 'LOT-2']);
});

test('拆分产生 split_from 血缘，母批次位置不变', () => {
  const world = makeWorld();
  const { commands, state } = world;
  setupColdBox(commands);
  commands.registerBox({ boxId: 'BOX-2', holder: '区域仓', ts: T0 });
  commands.split({ fromBatchId: 'LOT-1', newBatchId: 'LOT-1A', toBoxId: 'BOX-2', ts: T0 + HOUR });
  const edge = state.lineageEdges.find((e) => e.type === 'split_from');
  assert.equal(edge.from, 'LOT-1');
  assert.equal(edge.to, 'LOT-1A');
  // 母批次仍在 BOX-1
  assert.ok(state.containment.some((c) => c.batchId === 'LOT-1' && c.boxId === 'BOX-1' && c.to == null));
});

test('跨时区交接按 UTC 归一化排序，原始时区字符串保留', () => {
  const world = makeWorld();
  const { commands, queries, state } = world;
  commands.registerQualityRule({
    ruleId: 'cold-2-8',
    version: 1,
    minTemp: 2,
    maxTemp: 8,
    expectedIntervalSeconds: 600,
    maxGapMinutes: 30,
  });
  commands.registerBox({ boxId: 'BOX-TZ', holder: '上海仓', ts: T0 });
  // 上海 10:00 (+08:00) = UTC 02:00；芝加哥 09:00 (-05:00) = UTC 14:00
  commands.recordHandover({ boxId: 'BOX-TZ', fromHolder: '上海仓', toHolder: '干线车队', ts: '2026-09-01T10:00:00+08:00' });
  commands.recordHandover({ boxId: 'BOX-TZ', fromHolder: '干线车队', toHolder: '海外仓', ts: '2026-09-01T09:00:00-05:00' });

  const segments = queries.responsibilitySegments(state, 'BOX-TZ', { from: T0, to: T0 + 24 * HOUR });
  assert.deepEqual(
    segments.map((s) => [s.holder, s.from - T0, s.to - T0]),
    [
      ['上海仓', 0, 2 * HOUR],
      ['干线车队', 2 * HOUR, 14 * HOUR],
      ['海外仓', 14 * HOUR, 24 * HOUR],
    ],
  );
  const handovers = state.handovers.filter((h) => h.boxId === 'BOX-TZ');
  assert.equal(handovers[0].tsSource, '2026-09-01T10:00:00+08:00');
  assert.equal(handovers[1].tsSource, '2026-09-01T09:00:00-05:00');
});

test('交接责任方与实际不符时拒绝记录', () => {
  const world = makeWorld();
  setupColdBox(world.commands);
  assert.throws(
    () =>
      world.commands.recordHandover({
        boxId: 'BOX-1',
        fromHolder: '陌生人',
        toHolder: '司机丙',
        ts: T0 + HOUR,
      }),
    /责任方不符/,
  );
});

test('设备掉线解绑后，扫描视图中的缺口带 sensor_offline 原因', () => {
  const world = makeWorld();
  const { commands, queries, state, clock } = world;
  setupColdBox(commands);
  commands.unbindSensor({ boxId: 'BOX-1', sensorId: 'S-1', ts: T0 + 30 * MIN, reason: 'offline' });
  clock.set(T0 + HOUR);
  const scan = queries.scanBox(state, 'BOX-1', { from: T0, to: T0 + HOUR, now: clock.now });
  const reasons = scan.sections[0].intervals.filter((i) => i.class === 'gap').map((i) => i.reason);
  assert.deepEqual(reasons, ['data_missing', 'sensor_offline']);
});

test('未绑定到箱体的传感器上报片段被拒绝', () => {
  const world = makeWorld();
  setupColdBox(world.commands);
  world.commands.registerSensor({ sensorId: 'S-9' });
  assert.throws(
    () =>
      world.commands.ingestTemperatureSegment({
        boxId: 'BOX-1',
        sensorId: 'S-9',
        from: T0,
        to: T0 + 10 * MIN,
        points: [{ t: T0, v: 5 }],
      }),
    /未绑定到箱体/,
  );
});

test('同一箱体不能同时绑定两只传感器', () => {
  const world = makeWorld();
  setupColdBox(world.commands);
  world.commands.registerSensor({ sensorId: 'S-2' });
  assert.throws(
    () => world.commands.bindSensor({ boxId: 'BOX-1', sensorId: 'S-2', from: T0 }),
    /已有在绑传感器/,
  );
});

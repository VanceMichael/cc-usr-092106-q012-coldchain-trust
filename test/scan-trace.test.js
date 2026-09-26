// 接收方扫描视图与质量负责人追查视图。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, setupColdBox, points, T0, MIN, HOUR } from './helpers.js';

// 布景：一小时运输，前 20 分钟合格，20–30 分超限，30–50 分无数据（缺口），
// 50–60 分恢复合格；途中有一次开箱。
function buildScanWorld() {
  const world = makeWorld();
  const { commands, clock } = world;
  setupColdBox(commands);
  clock.set(T0 + HOUR);
  commands.ingestTemperatureSegment({
    boxId: 'BOX-1',
    sensorId: 'S-1',
    from: T0,
    to: T0 + HOUR,
    points: [
      ...points(T0, 2, 10 * MIN, 5), // 0/10 分合格
      { t: T0 + 20 * MIN, v: 12 }, // 20 分超限
      { t: T0 + 30 * MIN, v: 6 }, // 30 分恢复合格，覆盖到 40 分
      // 40–50 分无读数 → 缺口
      { t: T0 + 50 * MIN, v: 5 }, // 50 分合格
    ],
  });
  commands.recordBoxOpen({ boxId: 'BOX-1', ts: T0 + 45 * MIN, openedBy: '司机丙', reason: '例行查验' });
  return world;
}

test('接收方扫描一箱即可看到可核验区间、超限与缺口', () => {
  const world = buildScanWorld();
  const { queries, state, clock } = world;
  const scan = queries.scanBox(state, 'BOX-1', { from: T0, to: T0 + HOUR, now: clock.now });

  assert.equal(scan.boxId, 'BOX-1');
  assert.equal(scan.sections.length, 1);
  const section = scan.sections[0];
  assert.equal(section.ruleId, 'cold-2-8');

  const classes = section.intervals.map((i) => [i.class, i.reason ?? null, i.from - T0, i.to - T0]);
  assert.deepEqual(classes, [
    ['qualified', null, 0, 20 * MIN],
    ['excursion', null, 20 * MIN, 30 * MIN],
    ['qualified', null, 30 * MIN, 40 * MIN],
    ['gap', 'data_missing', 40 * MIN, 50 * MIN],
    ['qualified', null, 50 * MIN, 60 * MIN],
  ]);
  assert.equal(section.summary.excursionMs, 10 * MIN);
  assert.equal(section.summary.gapMs, 10 * MIN);

  // 开箱事件与当前批次都在视图中
  assert.equal(scan.opens.length, 1);
  assert.equal(scan.opens[0].openedBy, '司机丙');
  assert.deepEqual(
    section.batches.map((b) => b.batchId),
    ['LOT-1'],
  );
});

test('扫描视图展示批次的放行状态与处置记录', () => {
  const world = buildScanWorld();
  const { commands, queries, state, clock } = world;
  commands.issueRelease({ releaseId: 'REL-1', batchId: 'LOT-1', window: { from: T0, to: T0 + HOUR }, signedBy: 'QA-王' });
  commands.recordDisposition({
    batchId: 'LOT-1',
    type: 'observe',
    ruleId: 'cold-2-8',
    ruleVersion: 1,
    signedBy: 'QA-赵',
    reason: '存在短时超限，继续观察',
  });
  const scan = queries.scanBox(state, 'BOX-1', { from: T0, to: T0 + HOUR, now: clock.now });
  const batch = scan.sections[0].batches[0];
  assert.equal(batch.release.releaseId, 'REL-1');
  assert.equal(batch.release.status, 'issued');
  assert.equal(batch.dispositions.length, 1);
  assert.equal(batch.dispositions[0].dispositionType, 'observe');
  assert.equal(batch.dispositions[0].signedBy, 'QA-赵');
});

test('质量负责人可追查放行为何被撤销、哪些下游批次仍需通知', () => {
  const world = makeWorld();
  const { commands, queries, state, clock } = world;
  setupColdBox(commands);
  clock.set(T0 + HOUR);
  commands.ingestTemperatureSegment({
    boxId: 'BOX-1',
    sensorId: 'S-1',
    from: T0,
    to: T0 + HOUR,
    points: points(T0, 6, 10 * MIN, 5),
  });
  commands.issueRelease({ releaseId: 'REL-1', batchId: 'LOT-1', window: { from: T0, to: T0 + HOUR }, signedBy: 'QA-王' });

  // 下游：拆分子批次
  clock.set(T0 + 2 * HOUR);
  commands.registerBox({ boxId: 'BOX-2', holder: '区域仓', ts: T0 + 2 * HOUR });
  commands.split({ fromBatchId: 'LOT-1', newBatchId: 'LOT-1A', toBoxId: 'BOX-2', ts: T0 + 2 * HOUR });

  // 晚到数据 → 质疑 → 撤销
  clock.set(T0 + 3 * HOUR);
  commands.ingestTemperatureSegment({
    boxId: 'BOX-1',
    sensorId: 'S-1',
    from: T0,
    to: T0 + 30 * MIN,
    points: [{ t: T0 + 15 * MIN, v: 15 }],
  });
  commands.revokeRelease({ releaseId: 'REL-1', reason: '晚到数据显示运输超限', signedBy: 'QA-李' });

  const trace = queries.traceRelease(state, 'REL-1');
  assert.equal(trace.release.status, 'revoked');
  assert.equal(trace.release.revocation.reason, '晚到数据显示运输超限');
  assert.equal(trace.release.revocation.signedBy, 'QA-李');
  // 触发质疑的晚到片段可回溯到具体读数
  assert.equal(trace.lateSegments.length, 1);
  assert.equal(trace.lateSegments[0].segment.points[0].v, 15);
  // 下游批次 LOT-1A 仍待通知
  assert.deepEqual(trace.pendingBatches, ['LOT-1A']);
  assert.equal(trace.notifications[0].status, 'pending');

  commands.markNotificationSent({ notificationId: trace.notifications[0].notificationId, by: 'QA-李' });
  assert.deepEqual(queries.traceRelease(state, 'REL-1').pendingBatches, []);
});

test('批次在窗口内无箱体的时段标为 untracked 缺口', () => {
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
  commands.registerBatch({ batchId: 'LOT-X', product: '疫苗X', lot: 'L009', ruleId: 'cold-2-8', ruleVersion: 1 });
  commands.registerBox({ boxId: 'BOX-X', holder: '仓库甲', ts: T0 });
  commands.loadBatch({ batchId: 'LOT-X', boxId: 'BOX-X', ts: T0 + 2 * HOUR });
  const evidence = queries.batchEvidence(state, 'LOT-X', { from: T0, to: T0 + 3 * HOUR });
  assert.deepEqual(
    evidence.untracked.map((u) => [u.from - T0, u.to - T0]),
    [[0, 2 * HOUR]],
  );
  assert.equal(evidence.summary.gapMs, 3 * HOUR); // 2 小时 untracked + 1 小时箱内无数据
});

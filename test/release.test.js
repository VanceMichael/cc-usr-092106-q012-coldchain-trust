// 放行结论的不变量：签发即冻结；晚到数据只能质疑、不能改写；
// 撤销留痕并沿血缘图找出仍需通知的下游批次。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, setupColdBox, points, T0, MIN, HOUR } from './helpers.js';

function issuePassingRelease(world) {
  const { commands, clock } = world;
  clock.set(T0 + HOUR);
  commands.ingestTemperatureSegment({
    boxId: 'BOX-1',
    sensorId: 'S-1',
    from: T0,
    to: T0 + HOUR,
    points: points(T0, 6, 10 * MIN, 5),
  });
  return commands.issueRelease({
    releaseId: 'REL-1',
    batchId: 'LOT-1',
    window: { from: T0, to: T0 + HOUR },
    signedBy: 'QA-王',
  });
}

test('合格证据签发 pass 放行，结论带证据哈希', () => {
  const world = makeWorld();
  setupColdBox(world.commands);
  const event = issuePassingRelease(world);
  assert.equal(event.verdict, 'pass');
  assert.match(event.evidenceHash, /^[0-9a-f]{64}$/);
  assert.equal(event.signedBy, 'QA-王');
  assert.deepEqual(event.boxesInvolved, ['BOX-1']);
});

test('缺口超过规则容忍时签发 fail，缺口不被自动填平', () => {
  const world = makeWorld();
  setupColdBox(world.commands);
  world.clock.set(T0 + HOUR);
  // 全程无读数：60 分钟缺口 > 容忍 30 分钟
  const event = world.commands.issueRelease({
    releaseId: 'REL-GAP',
    batchId: 'LOT-1',
    window: { from: T0, to: T0 + HOUR },
    signedBy: 'QA-王',
  });
  assert.equal(event.verdict, 'fail');
  assert.equal(event.evidenceSummary.totals.gapMs, 60 * MIN);
});

test('晚到数据只把放行标记为 contested，原结论与证据哈希不变', () => {
  const world = makeWorld();
  setupColdBox(world.commands);
  issuePassingRelease(world);
  const before = world.state.releases.get('REL-1');
  const hashBefore = before.evidenceHash;

  // 设备补传：签发之后才收到的片段，内含超限读数
  world.clock.set(T0 + 2 * HOUR);
  const result = world.commands.ingestTemperatureSegment({
    boxId: 'BOX-1',
    sensorId: 'S-1',
    from: T0,
    to: T0 + 30 * MIN,
    points: [{ t: T0 + 15 * MIN, v: 15 }],
  });
  assert.deepEqual(result.contested, ['REL-1']);

  const after = world.state.releases.get('REL-1');
  assert.equal(after.status, 'contested');
  assert.equal(after.verdict, 'pass'); // 原结论不被改写
  assert.equal(after.evidenceHash, hashBefore);
  assert.equal(after.contestedBy.length, 1);
  assert.equal(after.contestedBy[0].reason, 'late_evidence');
});

test('撤销放行：原记录保留，撤销原因与签署人留痕，重复撤销报错', () => {
  const world = makeWorld();
  setupColdBox(world.commands);
  issuePassingRelease(world);
  world.clock.set(T0 + 2 * HOUR);
  world.commands.revokeRelease({ releaseId: 'REL-1', reason: '晚到数据显示运输超限', signedBy: 'QA-李' });

  const release = world.state.releases.get('REL-1');
  assert.equal(release.status, 'revoked');
  assert.equal(release.verdict, 'pass'); // 原结论仍在
  assert.deepEqual(release.revocation, {
    reason: '晚到数据显示运输超限',
    signedBy: 'QA-李',
    revokedAt: T0 + 2 * HOUR,
  });
  // 事件日志中签发与撤销两条都在
  const types = world.store.all().map((e) => e.type);
  assert.ok(types.includes('ReleaseIssued'));
  assert.ok(types.includes('ReleaseRevoked'));
  assert.throws(
    () => world.commands.revokeRelease({ releaseId: 'REL-1', reason: 'x', signedBy: 'QA-李' }),
    /已被撤销/,
  );
});

test('被质疑的放行可复核确认，确认后恢复 confirmed', () => {
  const world = makeWorld();
  setupColdBox(world.commands);
  issuePassingRelease(world);
  world.clock.set(T0 + 2 * HOUR);
  world.commands.ingestTemperatureSegment({
    boxId: 'BOX-1',
    sensorId: 'S-1',
    from: T0,
    to: T0 + 10 * MIN,
    points: [{ t: T0 + 5 * MIN, v: 4 }],
  });
  assert.equal(world.state.releases.get('REL-1').status, 'contested');
  world.commands.confirmRelease({ releaseId: 'REL-1', signedBy: 'QA-李', note: '补传数据仍在合格范围' });
  assert.equal(world.state.releases.get('REL-1').status, 'confirmed');
  // 未受质疑的放行不能直接确认
  assert.throws(
    () => world.commands.confirmRelease({ releaseId: 'REL-1', signedBy: 'QA-李' }),
    /只有被晚到数据质疑/,
  );
});

test('撤销后沿血缘通知下游：拼箱同运批次与拆分子批次', () => {
  const world = makeWorld();
  const { commands, clock } = world;
  setupColdBox(commands);
  issuePassingRelease(world);

  // 拼箱：LOT-1 与 LOT-2 同箱 B2 同运
  clock.set(T0 + 3 * HOUR);
  commands.registerBox({ boxId: 'BOX-2', holder: '承运乙', ts: T0 + 3 * HOUR });
  commands.registerBatch({ batchId: 'LOT-2', product: '疫苗Y', lot: 'L002', ruleId: 'cold-2-8', ruleVersion: 1 });
  commands.consolidate({ batchIds: ['LOT-1', 'LOT-2'], boxId: 'BOX-2', ts: T0 + 3 * HOUR });

  // 拆分：LOT-1 分出子批次 LOT-1A
  clock.set(T0 + 4 * HOUR);
  commands.registerBox({ boxId: 'BOX-3', holder: '区域仓', ts: T0 + 4 * HOUR });
  commands.split({ fromBatchId: 'LOT-1', newBatchId: 'LOT-1A', toBoxId: 'BOX-3', ts: T0 + 4 * HOUR });

  clock.set(T0 + 5 * HOUR);
  const { notified } = commands.revokeRelease({ releaseId: 'REL-1', reason: '补传证据显示失控', signedBy: 'QA-李' });
  const notifiedBatches = notified.map((n) => n.batchId).sort();
  assert.deepEqual(notifiedBatches, ['LOT-1A', 'LOT-2']);

  // 通知履约：标记一个后，待通知列表只剩另一个
  const pending = world.queries.pendingNotifications(world.state);
  assert.equal(pending.length, 2);
  commands.markNotificationSent({ notificationId: pending[0].notificationId, by: 'QA-李' });
  const remaining = world.queries.pendingNotifications(world.state);
  assert.equal(remaining.length, 1);
});

test('异常处置必须引用存在的规则版本并署名', () => {
  const world = makeWorld();
  setupColdBox(world.commands);
  assert.throws(
    () =>
      world.commands.recordDisposition({
        batchId: 'LOT-1',
        type: 'quarantine',
        ruleId: 'cold-2-8',
        ruleVersion: 99,
        signedBy: 'QA-赵',
      }),
    /质量规则不存在/,
  );
  assert.throws(
    () =>
      world.commands.recordDisposition({
        batchId: 'LOT-1',
        type: 'freeze',
        ruleId: 'cold-2-8',
        ruleVersion: 1,
        signedBy: 'QA-赵',
      }),
    /处置类型/,
  );
  assert.throws(
    () =>
      world.commands.recordDisposition({
        batchId: 'LOT-1',
        type: 'scrap',
        ruleId: 'cold-2-8',
        ruleVersion: 1,
      }),
    /签署人/,
  );
  const event = world.commands.recordDisposition({
    batchId: 'LOT-1',
    type: 'quarantine',
    ruleId: 'cold-2-8',
    ruleVersion: 1,
    signedBy: 'QA-赵',
    reason: '到库待复核',
  });
  assert.equal(event.type, 'DispositionRecorded');
  assert.equal(event.ruleVersion, 1);
});

test('质量规则按版本注册后不可变', () => {
  const world = makeWorld();
  setupColdBox(world.commands);
  assert.throws(
    () =>
      world.commands.registerQualityRule({
        ruleId: 'cold-2-8',
        version: 1,
        minTemp: 0,
        maxTemp: 5,
        expectedIntervalSeconds: 300,
        maxGapMinutes: 10,
      }),
    /不可变/,
  );
});

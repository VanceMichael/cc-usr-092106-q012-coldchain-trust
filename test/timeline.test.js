// 证据时间线的核心不变量：缺口必须显式，绝不用相邻读数自动填成合格。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBoxTimeline } from '../src/domain/timeline.js';
import { T0, MIN } from './helpers.js';

const RULE = { minTemp: 2, maxTemp: 8, expectedIntervalSeconds: 600, maxGapMinutes: 30 };
const WINDOW = { from: T0, to: T0 + 60 * MIN };
const BINDING = [{ sensorId: 'S-1', from: T0, to: null, endReason: null }];
const CALS = { 'S-1': [{ version: 'cal-1', validFrom: T0 - MIN, validTo: null }] };

function segment(points, to = WINDOW.to) {
  return [{ sensorId: 'S-1', from: points[0].t, to, points, calibrationVersion: 'cal-1' }];
}

test('读数中断的时段标为缺口，不被相邻读数填充', () => {
  // 0 分与 10 分有读数，之后直到 50 分才有下一个读数：
  // 10 分读数最多覆盖到 20 分（标称间隔 10 分钟），20–50 分必须是缺口。
  const { intervals, summary } = buildBoxTimeline({
    window: WINDOW,
    bindings: BINDING,
    segments: segment([
      { t: T0, v: 5 },
      { t: T0 + 10 * MIN, v: 6 },
      { t: T0 + 50 * MIN, v: 7 },
    ]),
    calibrationsBySensor: CALS,
    rule: RULE,
  });
  assert.deepEqual(
    intervals.map((i) => [i.class, i.reason ?? null, i.from - T0, i.to - T0]),
    [
      ['qualified', null, 0, 20 * MIN],
      ['gap', 'data_missing', 20 * MIN, 50 * MIN],
      ['qualified', null, 50 * MIN, 60 * MIN],
    ],
  );
  assert.equal(summary.gapMs, 30 * MIN);
});

test('超限读数标为 excursion，区间保留传感器身份与校准版本', () => {
  const { intervals } = buildBoxTimeline({
    window: { from: T0, to: T0 + 30 * MIN },
    bindings: BINDING,
    segments: segment(
      [
        { t: T0, v: 5 },
        { t: T0 + 10 * MIN, v: 12 },
        { t: T0 + 20 * MIN, v: 6 },
      ],
      T0 + 30 * MIN,
    ),
    calibrationsBySensor: CALS,
    rule: RULE,
  });
  const excursion = intervals.find((i) => i.class === 'excursion');
  assert.equal(excursion.from, T0 + 10 * MIN);
  assert.equal(excursion.to, T0 + 20 * MIN);
  assert.equal(excursion.sensorId, 'S-1');
  assert.equal(excursion.calibrationVersion, 'cal-1');
  assert.equal(excursion.value, 12);
});

test('设备掉线解绑后的时段标为 sensor_offline 缺口', () => {
  const bindings = [{ sensorId: 'S-1', from: T0, to: T0 + 30 * MIN, endReason: 'offline' }];
  const { intervals } = buildBoxTimeline({
    window: WINDOW,
    bindings,
    segments: [],
    calibrationsBySensor: CALS,
    rule: RULE,
  });
  assert.deepEqual(
    intervals.map((i) => [i.class, i.reason]),
    [
      ['gap', 'data_missing'], // 在绑但无数据
      ['gap', 'sensor_offline'], // 掉线之后
    ],
  );
  assert.equal(intervals[1].from, T0 + 30 * MIN);
});

test('校准过期时段的读数不可核验，标为 calibration_invalid 缺口', () => {
  const cals = { 'S-1': [{ version: 'cal-1', validFrom: T0 - MIN, validTo: T0 + 15 * MIN }] };
  const { intervals } = buildBoxTimeline({
    window: { from: T0 + 10 * MIN, to: T0 + 30 * MIN },
    bindings: BINDING,
    segments: segment(
      [
        { t: T0 + 10 * MIN, v: 5 },
        { t: T0 + 20 * MIN, v: 6 },
      ],
      T0 + 30 * MIN,
    ),
    calibrationsBySensor: cals,
    rule: RULE,
  });
  assert.deepEqual(
    intervals.map((i) => [i.class, i.reason ?? null]),
    [
      ['qualified', null],
      ['gap', 'calibration_invalid'],
    ],
  );
});

test('从未绑定传感器的时段标为 no_sensor 缺口', () => {
  const { intervals } = buildBoxTimeline({
    window: WINDOW,
    bindings: [],
    segments: [],
    calibrationsBySensor: {},
    rule: RULE,
  });
  assert.deepEqual(
    intervals.map((i) => [i.class, i.reason]),
    [['gap', 'no_sensor']],
  );
});

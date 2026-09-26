// 测试公共布景：可控时钟 + 内存事件存储 + 命令与查询。
import { createEventStore } from '../src/store/eventStore.js';
import { createProjection } from '../src/store/projection.js';
import { createCommands } from '../src/service/commands.js';
import * as queries from '../src/service/queries.js';

export const T0 = Date.parse('2026-09-01T00:00:00Z');
export const MIN = 60_000;
export const HOUR = 3_600_000;

export function makeWorld() {
  let t = T0;
  const clock = {
    now: () => t,
    set: (v) => {
      t = v;
    },
    advance: (ms) => {
      t += ms;
    },
  };
  const store = createEventStore({ now: clock.now });
  const { state } = createProjection(store);
  const commands = createCommands({ store, state, now: clock.now });
  return { store, state, commands, queries, clock };
}

// 常用档案：一条 2–8°C 规则、一只已校准传感器、一个箱、一个批次并入箱。
export function setupColdBox(commands, { boxId = 'BOX-1', batchId = 'LOT-1' } = {}) {
  commands.registerQualityRule({
    ruleId: 'cold-2-8',
    version: 1,
    minTemp: 2,
    maxTemp: 8,
    expectedIntervalSeconds: 600,
    maxGapMinutes: 30,
  });
  commands.registerSensor({ sensorId: 'S-1', model: 'TempLogger' });
  commands.calibrateSensor({ sensorId: 'S-1', version: 'cal-2026-01', validFrom: T0 - HOUR });
  commands.registerBox({ boxId, holder: '仓库甲', ts: T0 });
  commands.bindSensor({ boxId, sensorId: 'S-1', from: T0 });
  commands.registerBatch({ batchId, product: '疫苗X', lot: 'L001', ruleId: 'cold-2-8', ruleVersion: 1 });
  commands.loadBatch({ batchId, boxId, ts: T0 });
  return { boxId, batchId };
}

// 生成等间隔读数点。
export function points(from, count, stepMs, value) {
  return Array.from({ length: count }, (_, i) => ({
    t: from + i * stepMs,
    v: typeof value === 'function' ? value(i) : value,
  }));
}

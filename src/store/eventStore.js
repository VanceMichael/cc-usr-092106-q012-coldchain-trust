// 追加式事件存储：系统的唯一事实来源。
// 事件只增不改——放行结论、撤销、晚到数据都以新事件追加，
// 历史结论因此永远可追溯，不会被悄悄改写。
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

export function createEventStore({ filePath = null, now = () => Date.now() } = {}) {
  const events = [];
  const listeners = [];
  let seq = 0;

  if (filePath && existsSync(filePath)) {
    for (const line of readFileSync(filePath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      events.push(event);
      seq = event.seq;
    }
  }

  function append(type, payload) {
    const event = { seq: ++seq, type, recordedAt: now(), ...payload };
    events.push(event);
    if (filePath) appendFileSync(filePath, JSON.stringify(event) + '\n');
    for (const fn of listeners) fn(event);
    return event;
  }

  return {
    append,
    all: () => [...events],
    onAppend: (fn) => listeners.push(fn),
  };
}

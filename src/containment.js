// 重放只追加的事件流，还原每个批次的实际容纳区间与责任段。
// 换箱、拼箱、拆分不会抹平历史：旧区间在事件时刻封口，新区间从此刻开始。
import { ms, iso } from './time.js';

export function replayContainment(idx) {
  // contents: container -> [{batchId, qty}]
  const contents = new Map();
  // batchIntervals: batchId -> [{containerId, from, to, qty, taskId, eventId}]
  const batchIntervals = new Map();
  // parents: childBatchId -> [parentBatchId]（拆分谱系）
  const parents = new Map();
  // children: parentBatchId -> [childBatchId]
  const children = new Map();
  const openOf = new Map(); // key batch|container -> interval 引用

  const keyOf = (batchId, containerId) => `${batchId}@${containerId}`;
  const open = (batchId, containerId, at, qty, taskId, eventId) => {
    const iv = { batchId, containerId, from: at, to: null, qty, taskId, eventId };
    if (!batchIntervals.has(batchId)) batchIntervals.set(batchId, []);
    batchIntervals.get(batchId).push(iv);
    openOf.set(keyOf(batchId, containerId), iv);
    if (!contents.has(containerId)) contents.set(containerId, []);
    contents.get(containerId).push({ batchId, qty });
  };
  const close = (batchId, containerId, at) => {
    const iv = openOf.get(keyOf(batchId, containerId));
    if (iv) {
      iv.to = at;
      openOf.delete(keyOf(batchId, containerId));
    }
    const list = contents.get(containerId);
    if (list) {
      const pos = list.findIndex((e) => e.batchId === batchId);
      if (pos >= 0) list.splice(pos, 1);
    }
  };
  const batchesIn = (ev) => {
    if (ev.container_id && contents.has(ev.container_id)) {
      return contents.get(ev.container_id).map((e) => e.batchId);
    }
    return ev.batch_ids || [];
  };

  // 传感器在箱体上的安装区间
  const sensorMounts = new Map(); // container -> [{sensorId, from, to}]
  const openMount = new Map(); // container -> interval
  // 开门区间
  const doorOpens = new Map(); // container -> [{from, to}]
  const openDoor = new Map();

  // 责任段：batchId -> [{partyId, from, to, taskId, viaEvent}]
  const responsibility = new Map();
  const openResp = new Map(); // batchId -> interval
  const carrierOf = (taskId) => (taskId && idx.tasks.get(taskId)?.carrier_party_id) || null;
  const setOwner = (batchId, at, partyId, taskId, viaEvent) => {
    const cur = openResp.get(batchId);
    if (cur && cur.partyId === partyId) return;
    if (cur) cur.to = at;
    const iv = { partyId, from: at, to: null, taskId, viaEvent };
    if (!responsibility.has(batchId)) responsibility.set(batchId, []);
    responsibility.get(batchId).push(iv);
    openResp.set(batchId, iv);
  };

  for (const ev of idx.events) {
    const atIso = iso(ms(ev.at));
    switch (ev.type) {
      case 'pack': {
        for (const batchId of ev.batch_ids || []) {
          open(batchId, ev.container_id, atIso, qtyOf(idx, batchId), ev.task_id, ev.event_id);
          setOwner(batchId, atIso, ev.from_party || carrierOf(ev.task_id), ev.task_id, ev.event_id);
        }
        break;
      }
      case 'repack': {
        // 从旧箱取出、装入新箱；两箱都留下封口的区间，责任不跨箱继承。
        const fromList = contents.get(ev.from_container_id)?.map((e) => e.batchId) || ev.batch_ids || [];
        for (const batchId of fromList) {
          close(batchId, ev.from_container_id, atIso);
          open(batchId, ev.container_id, atIso, qtyOf(idx, batchId), ev.task_id, ev.event_id);
          setOwner(batchId, atIso, ev.from_party || carrierOf(ev.task_id), ev.task_id, ev.event_id);
        }
        break;
      }
      case 'split': {
        // 父批次（ev.batch_ids，当前在 container_id 内）整体拆成 outputs，装入各自的新容器。
        // 父子谱系只在此处建立一次；夹具约定一次拆分只有一个父批次。
        const parentIds = ev.batch_ids || [];
        for (const parentId of parentIds) close(parentId, ev.container_id, atIso);
        for (const out of ev.outputs || []) {
          for (const parentId of parentIds) {
            if (!parents.has(out.batch_id)) parents.set(out.batch_id, []);
            if (!parents.get(out.batch_id).includes(parentId)) parents.get(out.batch_id).push(parentId);
            if (!children.has(parentId)) children.set(parentId, []);
            children.get(parentId).push(out.batch_id);
          }
          open(out.batch_id, out.container_id, atIso, out.quantity, ev.task_id, ev.event_id);
          // 子批次的初始责任人取当时父批次的责任人，交接链由此续接而不是凭空开始。
          const parentOwner = openResp.get(parentIds[0])?.partyId || carrierOf(ev.task_id);
          setOwner(out.batch_id, atIso, parentOwner, ev.task_id, ev.event_id);
        }
        // 父批次实物已全部转入子批次容器：父批次责任段在拆分时刻封口，
        // 不再作为"当前仍被持有"的对象出现在下游通知里（谱系仍可向下追溯）。
        for (const parentId of parentIds) {
          const cur = openResp.get(parentId);
          if (cur) {
            cur.to = atIso;
            openResp.delete(parentId);
          }
        }
        break;
      }
      case 'unpack': {
        for (const batchId of batchesIn(ev)) close(batchId, ev.container_id, atIso);
        break;
      }
      case 'receipt': {
        // 签收即运输证据窗口关闭：货物进入接收方受控存储，
        // 本运单的可核验区间止于签收时刻（之后是仓储环节的另一段证据）。
        for (const batchId of batchesIn(ev)) {
          close(batchId, ev.container_id, atIso);
          if (ev.to_party) setOwner(batchId, atIso, ev.to_party, ev.task_id, ev.event_id);
        }
        break;
      }
      case 'handover': {
        const ids = ev.batch_ids?.length ? ev.batch_ids : batchesIn(ev);
        for (const batchId of ids) {
          if (ev.to_party) setOwner(batchId, atIso, ev.to_party, ev.task_id, ev.event_id);
        }
        break;
      }
      case 'attach': {
        const iv = { sensorId: ev.sensor_id, from: atIso, to: null };
        if (!sensorMounts.has(ev.container_id)) sensorMounts.set(ev.container_id, []);
        sensorMounts.get(ev.container_id).push(iv);
        openMount.set(ev.container_id, iv);
        break;
      }
      case 'detach': {
        const iv = openMount.get(ev.container_id);
        if (iv) {
          iv.to = atIso;
          openMount.delete(ev.container_id);
        }
        break;
      }
      case 'door_open': {
        const iv = { from: atIso, to: null };
        if (!doorOpens.has(ev.container_id)) doorOpens.set(ev.container_id, []);
        doorOpens.get(ev.container_id).push(iv);
        openDoor.set(ev.container_id, iv);
        break;
      }
      case 'door_close': {
        const iv = openDoor.get(ev.container_id);
        if (iv) {
          iv.to = atIso;
          openDoor.delete(ev.container_id);
        }
        break;
      }
      case 'receipt':
      default:
        break;
    }
  }

  // 未封口的区间一律开到证据包生成时刻，而不是被当作"数据完整"。
  const horizon = idx.raw.generated_at;
  for (const ivs of batchIntervals.values()) for (const iv of ivs) if (!iv.to) iv.to = horizon;
  for (const ivs of responsibility.values()) for (const iv of ivs) if (!iv.to) iv.to = horizon;
  for (const list of sensorMounts.values()) for (const iv of list) if (!iv.to) iv.to = horizon;
  for (const list of doorOpens.values()) for (const iv of list) if (!iv.to) iv.to = horizon;

  return { batchIntervals, responsibility, sensorMounts, doorOpens, parents, children };
}

function qtyOf(idx, batchId) {
  return idx.batches.get(batchId)?.initial_quantity ?? 1;
}

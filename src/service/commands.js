// 命令服务：所有状态变更的唯一入口，负责校验不变量并追加事件。
// 关键不变量：
//   - 温度片段必须由当时确实绑定在箱上的传感器上报（传感器身份可信）；
//   - 质量规则按版本注册后不可变；
//   - 放行结论只追加不改写，晚到数据只会把结论标记为 contested；
//   - 异常处置必须引用存在的规则版本并由签署人签名。
import { randomUUID, createHash } from 'node:crypto';
import { normalizeTime, toUtcMs, intersects } from '../domain/time.js';
import { ruleKey, validateRule, evaluateVerdict } from '../domain/rules.js';
import { downstreamBatches } from '../domain/lineage.js';
import { batchEvidence } from './queries.js';

const UNBIND_REASONS = new Set(['offline', 'swap', 'end']);
const DISPOSITION_TYPES = new Set(['observe', 'quarantine', 'scrap']);

export function createCommands({ store, state, now = () => Date.now() }) {
  const id = () => randomUUID();

  function mustSensor(sensorId) {
    const sensor = state.sensors.get(sensorId);
    if (!sensor) throw new Error(`传感器不存在: ${sensorId}`);
    return sensor;
  }

  function mustBox(boxId) {
    const box = state.boxes.get(boxId);
    if (!box) throw new Error(`箱体不存在: ${boxId}`);
    return box;
  }

  function mustBatch(batchId) {
    const batch = state.batches.get(batchId);
    if (!batch) throw new Error(`批次不存在: ${batchId}`);
    return batch;
  }

  function mustRule(ruleId, version) {
    const rule = state.rules.get(ruleKey(ruleId, version));
    if (!rule) throw new Error(`质量规则不存在: ${ruleId}@${version}`);
    return rule;
  }

  function openContainment(batchId) {
    return state.containment.find((c) => c.batchId === batchId && c.to == null) ?? null;
  }

  function currentHolder(boxId, atTs) {
    const last = state.handovers
      .filter((h) => h.boxId === boxId && h.ts <= atTs)
      .sort((a, b) => b.ts - a.ts)[0];
    return last ? last.toHolder : mustBox(boxId).holder;
  }

  return {
    // ---- 基础档案 ----

    registerQualityRule(rule) {
      validateRule(rule);
      if (state.rules.has(ruleKey(rule.ruleId, rule.version))) {
        throw new Error(`质量规则已存在且不可变: ${rule.ruleId}@${rule.version}`);
      }
      return store.append('QualityRuleRegistered', { ...rule });
    },

    registerSensor({ sensorId, model }) {
      if (state.sensors.has(sensorId)) throw new Error(`传感器已存在: ${sensorId}`);
      return store.append('SensorRegistered', { sensorId, model });
    },

    calibrateSensor({ sensorId, version, validFrom, validTo }) {
      const sensor = mustSensor(sensorId);
      if (sensor.calibrations.some((c) => c.version === version)) {
        throw new Error(`传感器 ${sensorId} 的校准版本已存在: ${version}`);
      }
      return store.append('SensorCalibrated', {
        sensorId,
        version,
        validFrom: toUtcMs(validFrom, 'validFrom'),
        validTo: validTo == null ? null : toUtcMs(validTo, 'validTo'),
      });
    },

    registerBox({ boxId, kind, holder, ts }) {
      if (state.boxes.has(boxId)) throw new Error(`箱体已存在: ${boxId}`);
      return store.append('BoxRegistered', {
        boxId,
        kind,
        holder: holder ?? null,
        registeredAt: ts == null ? now() : toUtcMs(ts, 'ts'),
      });
    },

    registerBatch({ batchId, product, lot, ruleId, ruleVersion, originBatchId }) {
      if (state.batches.has(batchId)) throw new Error(`批次已存在: ${batchId}`);
      mustRule(ruleId, ruleVersion);
      if (originBatchId != null) mustBatch(originBatchId);
      return store.append('BatchRegistered', { batchId, product, lot, ruleId, ruleVersion, originBatchId });
    },

    // ---- 传感器绑定（设备掉线/换绑在此留下显式记录）----

    bindSensor({ boxId, sensorId, from }) {
      mustBox(boxId);
      mustSensor(sensorId);
      if (state.bindings.some((b) => b.boxId === boxId && b.to == null)) {
        throw new Error(`箱体 ${boxId} 已有在绑传感器，请先解绑`);
      }
      if (state.bindings.some((b) => b.sensorId === sensorId && b.to == null)) {
        throw new Error(`传感器 ${sensorId} 仍绑定在其他箱体上`);
      }
      return store.append('SensorBound', { boxId, sensorId, from: toUtcMs(from, 'from') });
    },

    unbindSensor({ boxId, sensorId, ts, reason }) {
      mustBox(boxId);
      if (!UNBIND_REASONS.has(reason)) {
        throw new Error(`解绑原因必须是 ${[...UNBIND_REASONS].join('/')}`);
      }
      const binding = state.bindings.find((b) => b.boxId === boxId && b.sensorId === sensorId && b.to == null);
      if (!binding) throw new Error(`箱体 ${boxId} 上没有传感器 ${sensorId} 的在绑记录`);
      return store.append('SensorUnbound', { boxId, sensorId, ts: toUtcMs(ts, 'ts'), reason });
    },

    // ---- 批次装箱与箱操作（换箱/拼箱/拆分都保留实际责任段）----

    loadBatch({ batchId, boxId, ts, via = 'initial' }) {
      mustBatch(batchId);
      mustBox(boxId);
      if (openContainment(batchId)) throw new Error(`批次 ${batchId} 已在箱中，不能重复装箱`);
      return store.append('BatchLoaded', { batchId, boxId, ts: toUtcMs(ts, 'ts'), via });
    },

    unloadBatch({ batchId, boxId, ts, via = 'delivery' }) {
      mustBatch(batchId);
      const open = openContainment(batchId);
      if (!open || open.boxId !== boxId) throw new Error(`批次 ${batchId} 不在箱体 ${boxId} 中`);
      return store.append('BatchUnloaded', { batchId, boxId, ts: toUtcMs(ts, 'ts'), via });
    },

    // 换箱：批次从当前箱整体转移到目标箱，两段箱内责任分别保留。
    rebox({ batchId, toBoxId, ts, reason }) {
      const open = openContainment(mustBatch(batchId).batchId);
      if (!open) throw new Error(`批次 ${batchId} 当前不在任何箱体中`);
      mustBox(toBoxId);
      const at = toUtcMs(ts, 'ts');
      store.append('BatchUnloaded', { batchId, boxId: open.boxId, ts: at, via: 'rebox' });
      store.append('BatchLoaded', { batchId, boxId: toBoxId, ts: at, via: 'rebox' });
      return { batchId, fromBoxId: open.boxId, toBoxId, reason: reason ?? null };
    },

    // 拼箱：多个批次装入同一箱体，同运关系记入血缘图。
    consolidate({ batchIds, boxId, ts }) {
      mustBox(boxId);
      const at = toUtcMs(ts, 'ts');
      for (const batchId of batchIds) {
        mustBatch(batchId);
        const open = openContainment(batchId);
        if (open && open.boxId !== boxId) {
          store.append('BatchUnloaded', { batchId, boxId: open.boxId, ts: at, via: 'consolidation' });
        }
        if (!open || open.boxId !== boxId) {
          store.append('BatchLoaded', { batchId, boxId, ts: at, via: 'consolidation' });
        }
      }
      return { boxId, batchIds: [...batchIds] };
    },

    // 拆分：从母批次分出新批次（血缘 split_from），母批次保持原位。
    split({ fromBatchId, newBatchId, product, lot, toBoxId, ts }) {
      const origin = mustBatch(fromBatchId);
      if (state.batches.has(newBatchId)) throw new Error(`批次已存在: ${newBatchId}`);
      const event = store.append('BatchRegistered', {
        batchId: newBatchId,
        product: product ?? origin.product,
        lot: lot ?? origin.lot,
        ruleId: origin.ruleId,
        ruleVersion: origin.ruleVersion,
        originBatchId: fromBatchId,
      });
      if (toBoxId != null) {
        mustBox(toBoxId);
        store.append('BatchLoaded', { batchId: newBatchId, boxId: toBoxId, ts: toUtcMs(ts, 'ts'), via: 'split' });
      }
      return event;
    },

    // ---- 承运任务与交接 ----

    createTask({ taskId, carrier, vehicle }) {
      if (state.tasks.has(taskId)) throw new Error(`承运任务已存在: ${taskId}`);
      return store.append('TaskCreated', { taskId, carrier, vehicle });
    },

    attachBoxToTask({ taskId, boxId, from, to }) {
      if (!state.tasks.has(taskId)) throw new Error(`承运任务不存在: ${taskId}`);
      mustBox(boxId);
      return store.append('BoxAttachedToTask', {
        taskId,
        boxId,
        from: toUtcMs(from, 'from'),
        to: to == null ? null : toUtcMs(to, 'to'),
      });
    },

    // 交接：fromHolder 必须与该时刻的实际责任方一致，责任链才不会断。
    recordHandover({ boxId, fromHolder, toHolder, ts, handlers, taskId }) {
      mustBox(boxId);
      const { ts: at, tsSource } = normalizeTime(ts, 'ts');
      const holder = currentHolder(boxId, at);
      if (holder != null && fromHolder !== holder) {
        throw new Error(`交接责任方不符：箱体 ${boxId} 当时责任方为 ${holder}，而非 ${fromHolder}`);
      }
      if (taskId != null && !state.tasks.has(taskId)) throw new Error(`承运任务不存在: ${taskId}`);
      return store.append('HandoverRecorded', {
        handoverId: id(),
        boxId,
        fromHolder,
        toHolder,
        ts: at,
        tsSource,
        handlers,
        taskId,
      });
    },

    // ---- 温度片段与开箱事件 ----

    // 入库时解析校准版本并打上 receivedAt；随后检查是否构成晚到数据。
    ingestTemperatureSegment({ boxId, sensorId, from, to, points, segmentId }) {
      mustBox(boxId);
      const sensor = mustSensor(sensorId);
      const segFrom = toUtcMs(from, 'from');
      const segTo = toUtcMs(to, 'to');
      if (!(segFrom < segTo)) throw new Error('温度片段时间范围不合法');
      const binding = state.bindings.find(
        (b) => b.boxId === boxId && b.sensorId === sensorId && b.from <= segFrom && (b.to == null || segTo <= b.to),
      );
      if (!binding) {
        throw new Error(`传感器 ${sensorId} 在该时段未绑定到箱体 ${boxId}，片段拒绝入库`);
      }
      const normalizedPoints = points.map((p) => ({ t: toUtcMs(p.t, 'points[].t'), v: p.v }));
      for (const p of normalizedPoints) {
        if (p.t < segFrom || p.t > segTo) throw new Error('读数时间超出片段范围');
      }
      const calibration = sensor.calibrations.find(
        (c) => c.validFrom <= segFrom && (c.validTo == null || segFrom < c.validTo),
      );
      const receivedAt = now();
      const event = store.append('TemperatureSegmentIngested', {
        segmentId: segmentId ?? id(),
        boxId,
        sensorId,
        from: segFrom,
        to: segTo,
        points: normalizedPoints,
        calibrationVersion: calibration?.version ?? null,
        receivedAt,
      });

      // 晚到数据检测：片段与已发出/已确认的放行证据窗口相交，
      // 且接收时间晚于签发时间 → 只标记为 contested，绝不改写原结论。
      const contested = [];
      for (const release of state.releases.values()) {
        if (release.status !== 'issued' && release.status !== 'confirmed') continue;
        if (!release.boxesInvolved.includes(boxId)) continue;
        if (!intersects(release.window, { from: segFrom, to: segTo })) continue;
        if (receivedAt <= release.issuedAt) continue;
        store.append('ReleaseContested', {
          releaseId: release.releaseId,
          segmentId: event.segmentId,
          detectedAt: receivedAt,
          reason: 'late_evidence',
        });
        contested.push(release.releaseId);
      }
      return { segmentId: event.segmentId, calibrationVersion: event.calibrationVersion, contested };
    },

    recordBoxOpen({ boxId, ts, openedBy, reason }) {
      mustBox(boxId);
      const { ts: at, tsSource } = normalizeTime(ts, 'ts');
      return store.append('BoxOpened', { boxId, ts: at, tsSource, openedBy, reason });
    },

    // ---- 放行结论：签发即冻结，之后只能追加撤销/确认 ----

    issueRelease({ batchId, window, signedBy, releaseId }) {
      const batch = mustBatch(batchId);
      const rule = mustRule(batch.ruleId, batch.ruleVersion);
      if (!signedBy) throw new Error('放行必须由签署人签名');
      const w = { from: toUtcMs(window.from, 'window.from'), to: toUtcMs(window.to, 'window.to') };
      const evidence = batchEvidence(state, batchId, w);
      const verdict = evaluateVerdict(evidence.summary, rule);
      const evidenceSummary = {
        batchId,
        window: w,
        ruleId: rule.ruleId,
        ruleVersion: rule.version,
        intervals: evidence.intervals,
        totals: evidence.summary,
      };
      const evidenceHash = createHash('sha256').update(stableStringify(evidenceSummary)).digest('hex');
      return store.append('ReleaseIssued', {
        releaseId: releaseId ?? id(),
        batchId,
        window: w,
        ruleId: rule.ruleId,
        ruleVersion: rule.version,
        verdict,
        evidenceHash,
        evidenceSummary,
        boxesInvolved: evidence.boxesInvolved,
        issuedAt: now(),
        signedBy,
      });
    },

    // 撤销：原放行记录保留，撤销原因、签署人作为新事件追加；
    // 同时沿血缘图找出仍需通知的下游批次。
    revokeRelease({ releaseId, reason, signedBy }) {
      const release = state.releases.get(releaseId);
      if (!release) throw new Error(`放行结论不存在: ${releaseId}`);
      if (release.status === 'revoked') throw new Error(`放行结论已被撤销: ${releaseId}`);
      if (!reason || !signedBy) throw new Error('撤销必须给出原因并由签署人签名');
      const revokedAt = now();
      const event = store.append('ReleaseRevoked', { releaseId, reason, signedBy, revokedAt });
      const notified = [];
      for (const batchId of downstreamBatches(state.lineageEdges, release.batchId, release.window.from)) {
        const notificationId = id();
        store.append('NotificationRequired', {
          notificationId,
          batchId,
          sourceReleaseId: releaseId,
          reason: `放行 ${releaseId} 被撤销：${reason}`,
          createdAt: revokedAt,
        });
        notified.push({ notificationId, batchId });
      }
      return { event, notified };
    },

    // 复核后维持原结论：只对 contested 状态可用。
    confirmRelease({ releaseId, signedBy, note }) {
      const release = state.releases.get(releaseId);
      if (!release) throw new Error(`放行结论不存在: ${releaseId}`);
      if (release.status !== 'contested') {
        throw new Error(`只有被晚到数据质疑的放行才能复核确认，当前状态: ${release.status}`);
      }
      if (!signedBy) throw new Error('复核确认必须由签署人签名');
      return store.append('ReleaseConfirmed', { releaseId, signedBy, note, confirmedAt: now() });
    },

    // ---- 异常处置与通知 ----

    recordDisposition({ batchId, type, ruleId, ruleVersion, signedBy, reason }) {
      mustBatch(batchId);
      if (!DISPOSITION_TYPES.has(type)) {
        throw new Error(`处置类型必须是 ${[...DISPOSITION_TYPES].join('/')}`);
      }
      mustRule(ruleId, ruleVersion); // 必须引用当时存在的质量规则版本
      if (!signedBy) throw new Error('处置必须由签署人签名');
      return store.append('DispositionRecorded', {
        dispositionId: id(),
        batchId,
        dispositionType: type,
        ruleId,
        ruleVersion,
        signedBy,
        reason,
        createdAt: now(),
      });
    },

    markNotificationSent({ notificationId, by }) {
      const notification = state.notifications.get(notificationId);
      if (!notification) throw new Error(`通知不存在: ${notificationId}`);
      if (notification.status !== 'pending') throw new Error(`通知已处理: ${notificationId}`);
      return store.append('NotificationSent', { notificationId, ts: now(), by });
    },
  };
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

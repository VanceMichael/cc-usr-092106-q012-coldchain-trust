// 投影：把事件流折叠成查询所需的当前状态。
// 状态全部由事件派生，可随时重放重建；放行状态机为
// issued -> contested -> confirmed / revoked（revoked 为终态，原结论保留）。
import { ruleKey } from '../domain/rules.js';

export function createProjection(store) {
  const state = {
    sensors: new Map(), // sensorId -> { sensorId, model, calibrations: [] }
    boxes: new Map(), // boxId -> { boxId, kind, holder, registeredAt }
    batches: new Map(), // batchId -> { batchId, product, lot, ruleId, ruleVersion, originBatchId }
    tasks: new Map(), // taskId -> { taskId, carrier, vehicle }
    rules: new Map(), // ruleId@version -> rule
    releases: new Map(), // releaseId -> { ..., status, contestedBy: [], revocation?, confirmation? }
    notifications: new Map(), // notificationId -> { ..., status }
    bindings: [], // { boxId, sensorId, from, to, endReason }
    containment: [], // { batchId, boxId, from, to, via }
    handovers: [], // { boxId, fromHolder, toHolder, ts, tsSource?, handlers, taskId }
    opens: [], // { boxId, ts, openedBy, reason }
    segments: [], // 温度片段
    taskAttachments: [], // { taskId, boxId, from, to }
    dispositions: [], // { dispositionId, batchId, type, ruleId, ruleVersion, signedBy, reason, createdAt }
    lineageEdges: [], // split_from / shared_box
  };

  const handlers = {
    SensorRegistered(e) {
      state.sensors.set(e.sensorId, { sensorId: e.sensorId, model: e.model ?? null, calibrations: [] });
    },
    SensorCalibrated(e) {
      const sensor = state.sensors.get(e.sensorId);
      if (sensor) sensor.calibrations.push({ version: e.version, validFrom: e.validFrom, validTo: e.validTo ?? null });
    },
    BoxRegistered(e) {
      state.boxes.set(e.boxId, { boxId: e.boxId, kind: e.kind ?? null, holder: e.holder ?? null, registeredAt: e.registeredAt });
    },
    SensorBound(e) {
      state.bindings.push({ boxId: e.boxId, sensorId: e.sensorId, from: e.from, to: null, endReason: null });
    },
    SensorUnbound(e) {
      const binding = state.bindings.find((b) => b.boxId === e.boxId && b.sensorId === e.sensorId && b.to == null);
      if (binding) {
        binding.to = e.ts;
        binding.endReason = e.reason;
      }
    },
    BatchRegistered(e) {
      state.batches.set(e.batchId, {
        batchId: e.batchId,
        product: e.product,
        lot: e.lot,
        ruleId: e.ruleId,
        ruleVersion: e.ruleVersion,
        originBatchId: e.originBatchId ?? null,
      });
      if (e.originBatchId) {
        state.lineageEdges.push({ type: 'split_from', from: e.originBatchId, to: e.batchId, ts: e.recordedAt });
      }
    },
    BatchLoaded(e) {
      state.containment.push({ batchId: e.batchId, boxId: e.boxId, from: e.ts, to: null, via: e.via });
      if (e.via === 'consolidation') {
        // 拼箱：与同箱内在运批次互记 shared_box 边
        for (const c of state.containment) {
          if (c.boxId === e.boxId && c.batchId !== e.batchId && c.to == null) {
            state.lineageEdges.push({ type: 'shared_box', a: e.batchId, b: c.batchId, boxId: e.boxId, ts: e.ts });
          }
        }
      }
    },
    BatchUnloaded(e) {
      const open = state.containment.find((c) => c.batchId === e.batchId && c.boxId === e.boxId && c.to == null);
      if (open) open.to = e.ts;
    },
    TaskCreated(e) {
      state.tasks.set(e.taskId, { taskId: e.taskId, carrier: e.carrier, vehicle: e.vehicle ?? null });
    },
    BoxAttachedToTask(e) {
      state.taskAttachments.push({ taskId: e.taskId, boxId: e.boxId, from: e.from, to: e.to ?? null });
    },
    HandoverRecorded(e) {
      state.handovers.push({
        boxId: e.boxId,
        fromHolder: e.fromHolder,
        toHolder: e.toHolder,
        ts: e.ts,
        tsSource: e.tsSource,
        handlers: e.handlers ?? null,
        taskId: e.taskId ?? null,
      });
    },
    TemperatureSegmentIngested(e) {
      state.segments.push({
        segmentId: e.segmentId,
        boxId: e.boxId,
        sensorId: e.sensorId,
        from: e.from,
        to: e.to,
        points: e.points,
        calibrationVersion: e.calibrationVersion,
        receivedAt: e.receivedAt,
      });
    },
    BoxOpened(e) {
      state.opens.push({ boxId: e.boxId, ts: e.ts, tsSource: e.tsSource, openedBy: e.openedBy, reason: e.reason });
    },
    QualityRuleRegistered(e) {
      state.rules.set(ruleKey(e.ruleId, e.version), {
        ruleId: e.ruleId,
        version: e.version,
        minTemp: e.minTemp,
        maxTemp: e.maxTemp,
        expectedIntervalSeconds: e.expectedIntervalSeconds,
        maxGapMinutes: e.maxGapMinutes,
      });
    },
    ReleaseIssued(e) {
      state.releases.set(e.releaseId, {
        releaseId: e.releaseId,
        batchId: e.batchId,
        window: e.window,
        ruleId: e.ruleId,
        ruleVersion: e.ruleVersion,
        verdict: e.verdict,
        evidenceHash: e.evidenceHash,
        evidenceSummary: e.evidenceSummary,
        boxesInvolved: e.boxesInvolved,
        issuedAt: e.issuedAt,
        signedBy: e.signedBy,
        status: 'issued',
        contestedBy: [],
        revocation: null,
        confirmation: null,
      });
    },
    ReleaseContested(e) {
      const release = state.releases.get(e.releaseId);
      if (release && release.status !== 'revoked') {
        release.status = 'contested';
        release.contestedBy.push({ segmentId: e.segmentId, detectedAt: e.detectedAt, reason: e.reason });
      }
    },
    ReleaseConfirmed(e) {
      const release = state.releases.get(e.releaseId);
      if (release && release.status === 'contested') {
        release.status = 'confirmed';
        release.confirmation = { signedBy: e.signedBy, note: e.note ?? null, confirmedAt: e.confirmedAt };
      }
    },
    ReleaseRevoked(e) {
      const release = state.releases.get(e.releaseId);
      if (release && release.status !== 'revoked') {
        release.status = 'revoked';
        release.revocation = { reason: e.reason, signedBy: e.signedBy, revokedAt: e.revokedAt };
      }
    },
    DispositionRecorded(e) {
      state.dispositions.push({
        dispositionId: e.dispositionId,
        batchId: e.batchId,
        dispositionType: e.dispositionType,
        ruleId: e.ruleId,
        ruleVersion: e.ruleVersion,
        signedBy: e.signedBy,
        reason: e.reason,
        createdAt: e.createdAt,
      });
    },
    NotificationRequired(e) {
      state.notifications.set(e.notificationId, {
        notificationId: e.notificationId,
        batchId: e.batchId,
        sourceReleaseId: e.sourceReleaseId,
        reason: e.reason,
        createdAt: e.createdAt,
        status: 'pending',
        notifiedAt: null,
        notifiedBy: null,
      });
    },
    NotificationSent(e) {
      const n = state.notifications.get(e.notificationId);
      if (n) {
        n.status = 'notified';
        n.notifiedAt = e.ts;
        n.notifiedBy = e.by;
      }
    },
  };

  function apply(event) {
    handlers[event.type]?.(event);
  }

  for (const event of store.all()) apply(event);
  store.onAppend(apply);

  return { state };
}

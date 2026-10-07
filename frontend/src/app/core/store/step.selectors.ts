import { createFeatureSelector, createSelector } from '@ngrx/store';
import type { StepStateSlice } from './step.reducer';
import type { BridgeRow, ReadingRow, StepRow } from '../utils/db';
import { SYNC_REQUIREMENT_LABEL, syncLayoutHint, type StepView } from '../types/step';
import { analyzeStepBatches } from '../utils/batch';
import { syncLevel, type ToleranceLevel } from '../utils/tolerance';

export const selectStepState = createFeatureSelector<StepStateSlice>('step');
export const selectSteps = createSelector(selectStepState, (state) => state.steps);
export const selectReadings = createSelector(selectStepState, (state) => state.readings);
export const selectActiveStepBridgeId = createSelector(selectStepState, (state) => state.activeBridgeId);

/** 按桥梁分组 */
export const selectStepsByBridge = createSelector(selectSteps, (steps) => {
  const grouped = new Map<string, StepRow[]>();
  for (const step of steps) {
    const list = grouped.get(step.bridgeId) ?? [];
    list.push(step);
    grouped.set(step.bridgeId, list);
  }
  for (const list of grouped.values()) list.sort((a, b) => a.seq - b.seq);
  return grouped;
});

/** 找出受影响桥梁的步骤列表 */
export const selectActiveSteps = createSelector(
  selectSteps,
  selectActiveStepBridgeId,
  (steps, bridgeId) => steps.filter((item) => !bridgeId || item.bridgeId === bridgeId).sort((a, b) => a.seq - b.seq),
);

/** 步骤视图：含累计顶升量、批次复核与校验结论 */
export function buildStepViews(steps: StepRow[], readings: ReadingRow[], bridges: BridgeRow[]): StepView[] {
  const bridgeName = new Map(bridges.map((item) => [item.id, item.name]));
  const ordered = [...steps].sort((a, b) => a.seq - b.seq);
  let running = 0;
  return ordered.map((step) => {
    running += step.targetLiftMm;
    const rows = readings.filter((item) => item.stepId === step.id);
    const batchAnalysis = analyzeStepBatches(step.id, step.syncRequirement, readings, step.limitMm);
    const effective = batchAnalysis.effectiveBatch;
    const latest = batchAnalysis.latestBatch;
    const deviation = effective ? effective.syncDeviationMm : null;
    const cumulativeLiftMm = Number(running.toFixed(2));
    const overLimit = cumulativeLiftMm > step.limitMm;
    let validation: string;
    if (overLimit) {
      validation = `累计顶升量 ${cumulativeLiftMm} mm 超过限位 ${step.limitMm} mm`;
    } else if (!latest) {
      validation = '该步骤尚无复核读数';
    } else if (!effective) {
      validation = `最新批次 ${latest.recordedAt} 缺测（${latest.missingPoints.join('、')}），无有效复核结果`;
    } else {
      const batchFlaw = latest.valid ? '' : `（最新批次 ${latest.recordedAt} 缺测，已沿用 ${effective.recordedAt} 有效批次）`;
      validation =
        deviation !== null && syncLevel(deviation) === 'exceed'
          ? `有效批次 ${effective.recordedAt} 同步偏差 ${deviation.toFixed(2)} mm 超允许值${batchFlaw}`
          : `有效批次 ${effective.recordedAt} 监测数据在控制范围内${batchFlaw}`;
    }
    return {
      ...step,
      bridgeName: bridgeName.get(step.bridgeId) ?? '未归属桥梁',
      cumulativeLiftMm,
      overLimit,
      readingCount: rows.length,
      batchCount: batchAnalysis.batches.length,
      syncDeviationMm: deviation,
      effectiveAverageMm: effective ? effective.averageMm : null,
      effectiveBatchAt: effective ? effective.recordedAt : null,
      latestBatchAt: latest ? latest.recordedAt : null,
      latestBatchValid: latest ? latest.valid : null,
      latestMissingPoints: latest ? latest.missingPoints : [],
      effectiveExceedCount: effective ? effective.exceedCount : 0,
      effectiveWatchCount: effective ? effective.watchCount : 0,
      batchAnalysis,
      validation,
    };
  });
}

/** 步骤统计：总级数、累计顶升量、就位数、超限数 */
export const selectStepStats = createSelector(selectSteps, selectReadings, (steps, readings) => {
  const cumulative = steps.reduce((sum, item) => sum + item.targetLiftMm, 0);
  return {
    total: steps.length,
    cumulativeMm: Number(cumulative.toFixed(2)),
    arrived: steps.filter((item) => item.state === 'arrived').length,
    lifting: steps.filter((item) => item.state === 'lifting').length,
    idle: steps.filter((item) => item.state === 'idle').length,
    readingCount: readings.length,
    maxLimitMm: steps.reduce((max, item) => Math.max(max, item.limitMm), 0),
  };
});

/** 同步偏差等级（按步骤，取当前有效批次） */
export const selectSyncLevels = createSelector(selectReadings, selectSteps, (readings, steps) => {
  const result: Record<string, ToleranceLevel> = {};
  for (const step of steps) {
    const analysis = analyzeStepBatches(step.id, step.syncRequirement, readings, step.limitMm);
    result[step.id] = analysis.effectiveBatch ? analysis.effectiveBatch.level : 'ok';
  }
  return result;
});

/** 步骤同步布置建议 */
export const selectSyncHints = createSelector(selectSteps, (steps) =>
  steps.map((step) => ({
    id: step.id,
    seq: step.seq,
    requirement: SYNC_REQUIREMENT_LABEL[step.syncRequirement],
    hint: syncLayoutHint(step.syncRequirement),
  })),
);

/** 各步骤平均位移（当前有效批次口径，测点页展示） */
export const selectStepAverages = createSelector(selectReadings, selectSteps, (readings, steps) => {
  const result: Record<string, number> = {};
  for (const step of steps) {
    const analysis = analyzeStepBatches(step.id, step.syncRequirement, readings, step.limitMm);
    result[step.id] = analysis.effectiveBatch ? analysis.effectiveBatch.averageMm : 0;
  }
  return result;
});

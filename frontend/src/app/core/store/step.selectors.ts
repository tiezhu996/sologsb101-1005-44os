import { createFeatureSelector, createSelector } from '@ngrx/store';
import type { StepStateSlice } from './step.reducer';
import type { BridgeRow, ReadingRow, StepRow } from '../utils/db';
import { SYNC_REQUIREMENT_LABEL, syncLayoutHint, type StepView } from '../types/step';
import { syncLevel, type ToleranceLevel } from '../utils/tolerance';
import {
  evaluateArrivalGate,
  evaluateStepBatches,
  invalidBatchHint,
  type ArrivalGate,
  type StepBatchEvaluation,
} from '../utils/reading-batch';

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

/** 各步骤的批次评估（整批快照口径），步骤 id → 评估结果 */
export function buildStepBatchEvaluations(
  steps: StepRow[],
  readings: ReadingRow[],
): Map<string, StepBatchEvaluation> {
  const result = new Map<string, StepBatchEvaluation>();
  for (const step of steps) {
    result.set(step.id, evaluateStepBatches(step.id, readings, step.syncRequirement, step.limitMm));
  }
  return result;
}

/** 步骤视图：含累计顶升量、当前有效批次同步偏差与校验结论 */
export function buildStepViews(steps: StepRow[], readings: ReadingRow[], bridges: BridgeRow[]): StepView[] {
  const bridgeName = new Map(bridges.map((item) => [item.id, item.name]));
  const evaluations = buildStepBatchEvaluations(steps, readings);
  const ordered = [...steps].sort((a, b) => a.seq - b.seq);
  let running = 0;
  return ordered.map((step) => {
    running += step.targetLiftMm;
    const evaluation = evaluations.get(step.id)!;
    const activeBatch = evaluation.activeBatch;
    const deviation = activeBatch?.syncDeviationMm ?? null;
    const cumulativeLiftMm = Number(running.toFixed(2));
    const overLimit = cumulativeLiftMm > step.limitMm;
    const gate = evaluateArrivalGate(evaluation);
    let validation = '顶升参数与监测数据均在控制范围内';
    if (evaluation.withoutValidBatch) {
      validation =
        evaluation.latestBatch && !evaluation.latestBatch.valid
          ? `${invalidBatchHint(evaluation.latestBatch)}；尚无有效批次可沿用`
          : '尚无覆盖全部应有测点的有效复核批次，平均值 / 偏差 / 到位判断暂不可用';
    } else if (overLimit) {
      validation = `累计顶升量 ${cumulativeLiftMm} mm 超过限位 ${step.limitMm} mm`;
    } else if (gate.blocked && !gate.noValidBatch) {
      validation = `当前有效批次（${activeBatch?.recordedAt ?? ''}）不满足到位条件：${gate.reasons.join('；')}`;
    } else if (deviation !== null && syncLevel(deviation) === 'exceed') {
      validation = `同步偏差 ${deviation.toFixed(2)} mm 超允许值（依据批次 ${activeBatch?.recordedAt ?? ''}）`;
    } else if (evaluation.stale && evaluation.latestBatch) {
      validation = `${invalidBatchHint(evaluation.latestBatch)}；当前结论仍依据批次 ${activeBatch?.recordedAt ?? ''}`;
    }
    return {
      ...step,
      bridgeName: bridgeName.get(step.bridgeId) ?? '未归属桥梁',
      cumulativeLiftMm,
      overLimit,
      readingCount: readings.filter((item) => item.stepId === step.id).length,
      syncDeviationMm: deviation,
      activeBatchAt: activeBatch?.recordedAt ?? null,
      latestBatchInvalid: evaluation.latestBatch !== null && !evaluation.latestBatch.valid,
      latestBatchAt: evaluation.latestBatch?.recordedAt ?? null,
      activeAverageMm: activeBatch?.averageMm ?? null,
      activeExceedCount: evaluation.exceedCount,
      validBatchCount: evaluation.validBatchCount,
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

/** 同步偏差等级（按步骤，只取当前有效批次；无有效批次视为无数据，不升级为超限） */
export const selectSyncLevels = createSelector(selectReadings, selectSteps, (readings, steps) => {
  const evaluations = buildStepBatchEvaluations(steps, readings);
  const result: Record<string, ToleranceLevel> = {};
  for (const step of steps) {
    const deviation = evaluations.get(step.id)?.syncDeviationMm ?? null;
    result[step.id] = deviation === null ? 'ok' : syncLevel(deviation);
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

/** 各步骤当前有效批次平均位移（测点页展示） */
export const selectStepAverages = createSelector(selectReadings, selectSteps, (readings, steps) => {
  const evaluations = buildStepBatchEvaluations(steps, readings);
  const result: Record<string, number> = {};
  for (const step of steps) {
    result[step.id] = evaluations.get(step.id)?.averageMm ?? 0;
  }
  return result;
});

/** 各步骤到位拦截判断（顶升中 → 已到位 前使用） */
export const selectArrivalGates = createSelector(selectReadings, selectSteps, (readings, steps) => {
  const evaluations = buildStepBatchEvaluations(steps, readings);
  const result: Record<string, ArrivalGate> = {};
  for (const step of steps) {
    result[step.id] = evaluateArrivalGate(evaluations.get(step.id)!);
  }
  return result;
});

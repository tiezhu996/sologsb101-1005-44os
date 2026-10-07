/**
 * 顶升步骤时间线服务（Angular 以 Injectable 实现 useStepTimeline 语义）
 * 提供顶升步骤时间线、累计顶升量与同步偏差的 RxJS 派生流，
 * 被顶升步骤页、测点读数页消费。
 *
 * 复核口径：同一步骤、同一记录时间的读数为一批（整批快照）；
 * 平均值 / 同步偏差 / 超限统计 / 到位判断只看最近一批覆盖全部应有测点的复核，
 * 缺测批次判无效并沿用上一批有效结果，原始读数始终全部保留。
 */
import { Injectable, inject } from '@angular/core';
import { Observable, combineLatest, map, shareReplay } from 'rxjs';
import { IdbTableService } from './idb-table.service';
import { listBearings, listBridges, listReadings, listSteps } from '../utils/db';
import type { BridgeRow, BearingRow, ReadingRow, StepRow } from '../utils/db';
import { sortSteps, SYNC_REQUIREMENT_LABEL, type StepView } from '../types/step';
import type { ReadingView } from '../types/reading';
import { syncLevel, type ToleranceLevel } from '../utils/tolerance';
import {
  buildStepBatchEvaluations,
  evaluateArrivalGate,
  invalidBatchHint,
  type ReadingBatch,
  type StepBatchEvaluation,
} from '../utils/reading-batch';

/** 步骤时间线的一级节点 */
export interface StepTimelineNode {
  step: StepView;
  /** 该步骤的读数（含所属批次与偏差，原始记录全部保留） */
  readings: ReadingView[];
  /** 当前有效批次同步偏差等级 */
  deviationLevel: ToleranceLevel;
  /** 当前有效批次综合限位等级 */
  limitLevel: ToleranceLevel;
  /** 批次评估结果 */
  evaluation: StepBatchEvaluation;
}

/** 时间线汇总 */
export interface StepTimelineSnapshot {
  steps: StepRow[];
  readings: ReadingRow[];
  bearings: BearingRow[];
  bridges: BridgeRow[];
}

@Injectable({ providedIn: 'root' })
export class StepTimelineService {
  private readonly idb = inject(IdbTableService);

  /** 原始快照流 */
  readonly snapshot$: Observable<StepTimelineSnapshot> = this.idb
    .watch<StepTimelineSnapshot>(
      async () => {
        const [steps, readings, bearings, bridges] = await Promise.all([
          listSteps(),
          listReadings(),
          listBearings(),
          listBridges(),
        ]);
        return { steps, readings, bearings, bridges };
      },
      { steps: [], readings: [], bearings: [], bridges: [] },
    )
    .pipe(shareReplay({ bufferSize: 1, refCount: true }));

  /** 步骤视图流：含累计顶升量、当前有效批次同步偏差与校验结论 */
  readonly stepViews$: Observable<StepView[]> = this.snapshot$.pipe(
    map((snapshot) => this.buildStepViews(snapshot)),
    shareReplay({ bufferSize: 1, refCount: true }),
  );

  /** 时间线节点流：步骤 + 该步读数（标注批次）+ 当前有效批次等级判定 */
  readonly timeline$: Observable<StepTimelineNode[]> = combineLatest([
    this.stepViews$,
    this.snapshot$,
  ]).pipe(
    map(([steps, snapshot]) => {
      const bridges = new Map(snapshot.bridges.map((item) => [item.id, item.name]));
      const evaluations = buildStepBatchEvaluations(snapshot.steps, snapshot.readings);
      return steps.map((step) => {
        const evaluation = evaluations.get(step.id)!;
        const batchByTime = new Map<string, ReadingBatch>(evaluation.batches.map((batch) => [batch.recordedAt, batch]));
        const activeAt = evaluation.activeBatch?.recordedAt ?? null;
        const latestAt = evaluation.latestBatch?.recordedAt ?? null;
        const stepReadings = snapshot.readings
          .filter((item) => item.stepId === step.id)
          .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt) || a.pointCode.localeCompare(b.pointCode))
          .map<ReadingView>((reading) => {
            const batch = batchByTime.get(reading.recordedAt);
            // 偏差只在本批为有效整批快照时给出；缺测批次不参与计算
            const ownAverage =
              batch && batch.valid && batch.averageMm !== null ? batch.averageMm : null;
            const inActive = batch?.valid === true && batch.recordedAt === activeAt;
            const overLimit =
              inActive && step.limitMm > 0 && Math.abs(reading.displacementMm) >= step.limitMm;
            const stressAlert = inActive && reading.stressMpa >= 12;
            return {
              ...reading,
              stepSeq: step.seq,
              bridgeId: step.bridgeId,
              bridgeName: bridges.get(step.bridgeId) ?? '未归属桥梁',
              syncRequirement: SYNC_REQUIREMENT_LABEL[step.syncRequirement],
              deviationMm:
                ownAverage === null ? null : Number((reading.displacementMm - ownAverage).toFixed(3)),
              batchValid: batch?.valid ?? false,
              inActiveBatch: inActive,
              inLatestBatch: batch?.recordedAt === latestAt,
              batchInvalidNote: batch && !batch.valid ? invalidBatchHint(batch) : '',
              overLimit,
              stressAlert,
            };
          });
        const gate = evaluateArrivalGate(evaluation);
        const deviation = evaluation.syncDeviationMm ?? 0;
        return {
          step,
          readings: stepReadings,
          deviationLevel: evaluation.activeBatch ? syncLevel(deviation) : 'ok',
          limitLevel: gate.blocked && !gate.noValidBatch ? 'exceed' : evaluation.watchCount > 0 ? 'watch' : 'ok',
          evaluation,
        };
      });
    }),
    shareReplay({ bufferSize: 1, refCount: true }),
  );

  /** 按桥梁分组的步骤流 */
  readonly stepsByBridge$: Observable<Map<string, StepView[]>> = this.stepViews$.pipe(
    map((steps) => {
      const grouped = new Map<string, StepView[]>();
      for (const step of steps) {
        const list = grouped.get(step.bridgeId) ?? [];
        list.push(step);
        grouped.set(step.bridgeId, list);
      }
      return grouped;
    }),
    shareReplay({ bufferSize: 1, refCount: true }),
  );

  /** 累计顶升量流：桥梁 id → 累计值 */
  readonly cumulativeLift$: Observable<Record<string, number>> = this.stepViews$.pipe(
    map((steps) => {
      const totals: Record<string, number> = {};
      for (const step of steps) {
        totals[step.bridgeId] = Number(((totals[step.bridgeId] ?? 0) + step.targetLiftMm).toFixed(2));
      }
      return totals;
    }),
    shareReplay({ bufferSize: 1, refCount: true }),
  );

  /** 当前有效批次同步偏差流：步骤 id → 偏差（无有效批次为 null） */
  readonly syncDeviation$: Observable<Record<string, number | null>> = this.snapshot$.pipe(
    map((snapshot) => {
      const evaluations = buildStepBatchEvaluations(snapshot.steps, snapshot.readings);
      const result: Record<string, number | null> = {};
      for (const step of snapshot.steps) {
        result[step.id] = evaluations.get(step.id)?.syncDeviationMm ?? null;
      }
      return result;
    }),
    shareReplay({ bufferSize: 1, refCount: true }),
  );

  /** 构建步骤视图（供派生流与页面共用，口径与 step.selectors 的 buildStepViews 一致） */
  buildStepViews(snapshot: StepTimelineSnapshot): StepView[] {
    const bridgeName = new Map(snapshot.bridges.map((item) => [item.id, item.name]));
    const ordered = sortSteps(snapshot.steps);
    const evaluations = buildStepBatchEvaluations(ordered, snapshot.readings);
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
        validation = `累计顶升量 ${cumulativeLiftMm} mm 已超过限位 ${step.limitMm} mm，需立即停止并复核`;
      } else if (gate.blocked && !gate.noValidBatch) {
        validation = `当前有效批次（${activeBatch?.recordedAt ?? ''}）不满足到位条件：${gate.reasons.join('；')}`;
      } else if (deviation !== null && syncLevel(deviation) === 'exceed') {
        validation = `同步偏差 ${deviation.toFixed(2)} mm 超允许值，需调平后继续（依据批次 ${activeBatch?.recordedAt ?? ''}）`;
      } else if (evaluation.stale && evaluation.latestBatch) {
        validation = `${invalidBatchHint(evaluation.latestBatch)}；当前结论仍依据批次 ${activeBatch?.recordedAt ?? ''}`;
      }
      return {
        ...step,
        bridgeName: bridgeName.get(step.bridgeId) ?? '未归属桥梁',
        cumulativeLiftMm,
        overLimit,
        readingCount: snapshot.readings.filter((item) => item.stepId === step.id).length,
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
}

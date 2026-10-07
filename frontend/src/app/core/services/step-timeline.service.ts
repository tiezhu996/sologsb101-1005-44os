/**
 * 顶升步骤时间线服务（Angular 以 Injectable 实现 useStepTimeline 语义）
 * 提供顶升步骤时间线、累计顶升量与同步偏差的 RxJS 派生流，
 * 被顶升步骤页、测点读数页消费。
 *
 * 复核口径：同一记录时间为一批，平均值 / 同步偏差 / 超限只取最近一个
 * 覆盖全部应有测点的有效批次；缺测批次判无效并沿用上一批有效结果。
 */
import { Injectable, inject } from '@angular/core';
import { Observable, combineLatest, map, shareReplay } from 'rxjs';
import { IdbTableService } from './idb-table.service';
import { listBearings, listBridges, listReadings, listSteps } from '../utils/db';
import type { BridgeRow, BearingRow, ReadingRow, StepRow } from '../utils/db';
import { sortSteps, SYNC_REQUIREMENT_LABEL, type StepView } from '../types/step';
import { STRESS_ALERT_MPA, type ReadingView } from '../types/reading';
import { analyzeStepBatches } from '../utils/batch';
import { syncLevel, type ToleranceLevel } from '../utils/tolerance';

/** 步骤时间线的一级节点 */
export interface StepTimelineNode {
  step: StepView;
  /** 该步骤的读数（含偏差） */
  readings: ReadingView[];
  /** 同步偏差等级 */
  deviationLevel: ToleranceLevel;
  /** 综合限位等级 */
  limitLevel: ToleranceLevel;
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

  /** 步骤视图流：含累计顶升量、批次复核与校验结论 */
  readonly stepViews$: Observable<StepView[]> = this.snapshot$.pipe(
    map((snapshot) => this.buildStepViews(snapshot)),
    shareReplay({ bufferSize: 1, refCount: true }),
  );

  /** 时间线节点流：步骤 + 该步读数 + 等级判定（只看当前有效批次） */
  readonly timeline$: Observable<StepTimelineNode[]> = combineLatest([
    this.stepViews$,
    this.snapshot$,
  ]).pipe(
    map(([steps, snapshot]) => {
      const bridges = new Map(snapshot.bridges.map((item) => [item.id, item.name]));
      return steps.map((step) => {
        const effective = step.batchAnalysis.effectiveBatch;
        // 相对平均偏差只在该读数所属批次有效（完整）时有意义，否则给 0 且不参与判定
        const stepReadings = snapshot.readings
          .filter((item) => item.stepId === step.id)
          .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))
          .map<ReadingView>((reading) => {
            const sameBatch = snapshot.readings.filter(
              (item) => item.stepId === reading.stepId && item.recordedAt === reading.recordedAt,
            );
            const ownBatch = step.batchAnalysis.batches.find((b) => b.recordedAt === reading.recordedAt);
            const average = ownBatch?.valid
              ? sameBatch.reduce((sum, item) => sum + item.displacementMm, 0) / sameBatch.length
              : 0;
            return {
              ...reading,
              stepSeq: step.seq,
              bridgeId: step.bridgeId,
              bridgeName: bridges.get(step.bridgeId) ?? '未归属桥梁',
              syncRequirement: SYNC_REQUIREMENT_LABEL[step.syncRequirement],
              deviationMm: ownBatch?.valid ? Number((reading.displacementMm - average).toFixed(3)) : 0,
              overLimit: Math.abs(reading.displacementMm) >= step.limitMm,
              stressAlert: reading.stressMpa >= STRESS_ALERT_MPA,
            };
          });
        const effectiveViolations = effective?.violations ?? [];
        const limitLevel: ToleranceLevel = !effective
          ? 'ok'
          : effectiveViolations.some((v) => v.displacementLimit || v.stressAlert)
            ? 'exceed'
            : effectiveViolations.some(
                  (v) =>
                    (step.limitMm > 0 && Math.abs(v.displacementMm) >= step.limitMm * 0.8) ||
                    v.stressMpa >= STRESS_ALERT_MPA * 0.8,
                )
              ? 'watch'
              : 'ok';
        return {
          step,
          readings: stepReadings,
          deviationLevel: effective ? syncLevel(effective.syncDeviationMm) : 'ok',
          limitLevel,
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

  /** 同步偏差流：步骤 id → 当前有效批次偏差（无有效批次为 0） */
  readonly syncDeviation$: Observable<Record<string, number>> = this.snapshot$.pipe(
    map((snapshot) => {
      const result: Record<string, number> = {};
      for (const step of snapshot.steps) {
        const analysis = analyzeStepBatches(step.id, step.syncRequirement, snapshot.readings, step.limitMm);
        result[step.id] = analysis.effectiveBatch ? analysis.effectiveBatch.syncDeviationMm : 0;
      }
      return result;
    }),
    shareReplay({ bufferSize: 1, refCount: true }),
  );

  /** 构建步骤视图（供派生流与页面共用） */
  buildStepViews(snapshot: StepTimelineSnapshot): StepView[] {
    const bridgeName = new Map(snapshot.bridges.map((item) => [item.id, item.name]));
    const ordered = sortSteps(snapshot.steps);
    const cumulative = new Map<string, number>();
    let running = 0;
    for (const step of ordered) {
      running += step.targetLiftMm;
      cumulative.set(step.id, Number(running.toFixed(2)));
    }
    return ordered.map((step) => {
      const rows = snapshot.readings.filter((item) => item.stepId === step.id);
      const cumulativeLiftMm = cumulative.get(step.id) ?? step.targetLiftMm;
      const overLimit = cumulativeLiftMm > step.limitMm;
      const batchAnalysis = analyzeStepBatches(step.id, step.syncRequirement, snapshot.readings, step.limitMm);
      const effective = batchAnalysis.effectiveBatch;
      const latest = batchAnalysis.latestBatch;
      const deviation = effective ? effective.syncDeviationMm : null;
      let validation: string;
      if (overLimit) {
        validation = `累计顶升量 ${cumulativeLiftMm} mm 已超过限位 ${step.limitMm} mm，需立即停止并复核`;
      } else if (!latest) {
        validation = '该步骤尚无复核读数';
      } else if (!effective) {
        validation = `最新批次 ${latest.recordedAt} 缺测（${latest.missingPoints.join('、')}），无有效复核结果`;
      } else {
        const flaw = latest.valid ? '' : `（最新批次缺测，已沿用 ${effective.recordedAt} 有效批次）`;
        validation =
          deviation !== null && syncLevel(deviation) === 'exceed'
            ? `有效批次 ${effective.recordedAt} 同步偏差 ${deviation.toFixed(2)} mm 超允许值，需调平后继续${flaw}`
            : `有效批次 ${effective.recordedAt} 监测数据均在控制范围内${flaw}`;
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
}

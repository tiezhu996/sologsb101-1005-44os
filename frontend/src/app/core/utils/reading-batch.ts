/**
 * 复核批次口径：
 * - 同一步骤、同一记录时间的测点记录归为一批（整批快照，不按各测点最新值拼凑）
 * - 原始读数全部保留；只有「最近一批覆盖全部应有测点」的复核批次为当前有效批次
 * - 平均值 / 同步偏差 / 超限统计 / 到位判断只看当前有效批次
 * - 最新批次缺测（含测点重复）时判为无效，提示并沿用上一批有效结果
 */
import type { Reading } from '../types/reading';
import type { SyncRequirement } from '../types/step';
import { meanDisplacement, syncDeviationMm, STRESS_ALERT_MPA } from '../types/reading';
import { SYNC_TOLERANCE_MM } from './tolerance';

/** 应有测点编号：同步 / 交叉为四角 P1~P4，单点仅 P1 */
export function expectedPointCodes(syncRequirement: SyncRequirement): string[] {
  return syncRequirement === 'single' ? ['P1'] : ['P1', 'P2', 'P3', 'P4'];
}

/** 单批复核的测点超限项 */
export interface BatchPointBreach {
  pointCode: string;
  /** 位移达到/超过限位值 */
  displacementLimit: boolean;
  /** 应力达到关注值 */
  stressAlert: boolean;
  displacementMm: number;
  stressMpa: number;
}

/** 一批复核快照 */
export interface ReadingBatch {
  stepId: string;
  /** 批次记录时间（yyyy-MM-dd HH:mm） */
  recordedAt: string;
  /** 本批原始记录（不剔除、不覆盖） */
  readings: Reading[];
  pointCodes: string[];
  /** 应有测点 */
  expectedPointCodes: string[];
  /** 是否完整覆盖全部应有测点且无重复（完整才有效） */
  valid: boolean;
  /** 缺测 / 重复 / 多余测点说明 */
  missingPointCodes: string[];
  duplicatePointCodes: string[];
  extraPointCodes: string[];
  /** 有效批次的整批复核指标；无效批次为 null */
  averageMm: number | null;
  syncDeviationMm: number | null;
  /** 本批超限统计（无效批次为 null） */
  exceedCount: number | null;
  watchCount: number | null;
  okCount: number | null;
  /** 本批各测点超限项（无效批次为空） */
  breaches: BatchPointBreach[];
}

/** 一个步骤的批次评估结果 */
export interface StepBatchEvaluation {
  stepId: string;
  /** 全部批次，按记录时间倒序（最新在前） */
  batches: ReadingBatch[];
  /** 最新批次（无论是否有效） */
  latestBatch: ReadingBatch | null;
  /** 当前有效批次：最近一批覆盖全部应有测点的复核（缺测则沿用上一批） */
  activeBatch: ReadingBatch | null;
  /** 最新批次无效，当前结果沿用了更早的有效批次 */
  stale: boolean;
  /** 从未有过有效批次 */
  withoutValidBatch: boolean;
  /** 有效批次平均位移（mm），无有效批次为 null */
  averageMm: number | null;
  /** 有效批次同步偏差（mm，极差），无有效批次为 null */
  syncDeviationMm: number | null;
  /** 有效批次超限 / 关注 / 正常测点数 */
  exceedCount: number;
  watchCount: number;
  okCount: number;
  /** 有效批次数（原始记录全部保留） */
  validBatchCount: number;
  /** 有效批次原始读数条数 */
  activeReadingCount: number;
}

/** 到位拦截项 */
export interface ArrivalBlockItem {
  pointCode: string;
  /** 超限项描述：位移限位 / 应力关注值 */
  items: string[];
}

/** 顶升中 → 已到位 的拦截判断 */
export interface ArrivalGate {
  blocked: boolean;
  /** 是否因尚无有效复核批次而拦截 */
  noValidBatch: boolean;
  /** 拦截原因汇总（写明批次、测点和超限项） */
  reasons: string[];
  /** 超限测点明细 */
  items: ArrivalBlockItem[];
  /** 判断所依据的批次记录时间 */
  batchRecordedAt: string | null;
}

/** 组装单批（不做完整性判定之外的清洗，多余测点原样保留在 readings 中） */
export function buildBatch(
  stepId: string,
  recordedAt: string,
  rows: Reading[],
  syncRequirement: SyncRequirement,
  limitMm: number,
): ReadingBatch {
  const readings = [...rows].sort((a, b) => a.pointCode.localeCompare(b.pointCode));
  const expected = expectedPointCodes(syncRequirement);

  const seen = new Set<string>();
  const duplicatePointCodes: string[] = [];
  for (const row of readings) {
    if (seen.has(row.pointCode)) {
      if (!duplicatePointCodes.includes(row.pointCode)) duplicatePointCodes.push(row.pointCode);
    } else {
      seen.add(row.pointCode);
    }
  }
  const presentCodes = [...new Set(readings.map((item) => item.pointCode))].sort((a, b) =>
    a.localeCompare(b),
  );
  const missingPointCodes = expected.filter((code) => !seen.has(code));
  const extraPointCodes = presentCodes.filter((code) => !expected.includes(code));
  const valid = missingPointCodes.length === 0 && duplicatePointCodes.length === 0 && readings.length > 0;

  if (!valid) {
    return {
      stepId,
      recordedAt,
      readings,
      pointCodes: presentCodes,
      expectedPointCodes: expected,
      valid: false,
      missingPointCodes,
      duplicatePointCodes,
      extraPointCodes,
      averageMm: null,
      syncDeviationMm: null,
      exceedCount: null,
      watchCount: null,
      okCount: null,
      breaches: [],
    };
  }

  // 整批快照：平均、极差、各测点超限均以本批应有测点的记录为准
  const scoped = expected.map((code) => readings.find((item) => item.pointCode === code)!).filter(Boolean);
  const breaches: BatchPointBreach[] = scoped
    .map((row) => {
      const displacementLimit = limitMm > 0 && Math.abs(row.displacementMm) >= limitMm;
      const stressAlert = row.stressMpa >= STRESS_ALERT_MPA;
      return displacementLimit || stressAlert
        ? {
            pointCode: row.pointCode,
            displacementLimit,
            stressAlert,
            displacementMm: row.displacementMm,
            stressMpa: row.stressMpa,
          }
        : null;
    })
    .filter((item): item is BatchPointBreach => item !== null);

  let exceedCount = 0;
  let watchCount = 0;
  let okCount = 0;
  for (const row of scoped) {
    const displacementLimit = limitMm > 0 && Math.abs(row.displacementMm) >= limitMm;
    const stressAlert = row.stressMpa >= STRESS_ALERT_MPA;
    if (displacementLimit || stressAlert) {
      exceedCount += 1;
    } else if (
      (limitMm > 0 && Math.abs(row.displacementMm) >= limitMm * 0.8) ||
      row.stressMpa >= STRESS_ALERT_MPA * 0.8
    ) {
      watchCount += 1;
    } else {
      okCount += 1;
    }
  }

  return {
    stepId,
    recordedAt,
    readings,
    pointCodes: presentCodes,
    expectedPointCodes: expected,
    valid: true,
    missingPointCodes,
    duplicatePointCodes,
    extraPointCodes,
    averageMm: meanDisplacement(scoped),
    syncDeviationMm: syncDeviationMm(scoped),
    exceedCount,
    watchCount,
    okCount,
    breaches,
  };
}

/**
 * 评估一个步骤的全部复核批次。
 * 批次 = 同一步骤 + 同一记录时间；按记录时间倒序，
 * 当前有效批次取最近一批 valid=true 的快照。
 */
export function evaluateStepBatches(
  stepId: string,
  allReadings: Reading[],
  syncRequirement: SyncRequirement,
  limitMm: number,
): StepBatchEvaluation {
  const groups = new Map<string, Reading[]>();
  for (const reading of allReadings) {
    if (reading.stepId !== stepId) continue;
    const list = groups.get(reading.recordedAt) ?? [];
    list.push(reading);
    groups.set(reading.recordedAt, list);
  }

  const batches = [...groups.entries()]
    .map(([recordedAt, rows]) => buildBatch(stepId, recordedAt, rows, syncRequirement, limitMm))
    .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));

  const latestBatch = batches[0] ?? null;
  const activeBatch = batches.find((batch) => batch.valid) ?? null;
  const stale = latestBatch !== null && !latestBatch.valid && activeBatch !== null;
  const withoutValidBatch = activeBatch === null;

  return {
    stepId,
    batches,
    latestBatch,
    activeBatch,
    stale,
    withoutValidBatch,
    averageMm: activeBatch?.averageMm ?? null,
    syncDeviationMm: activeBatch?.syncDeviationMm ?? null,
    exceedCount: activeBatch?.exceedCount ?? 0,
    watchCount: activeBatch?.watchCount ?? 0,
    okCount: activeBatch?.okCount ?? 0,
    validBatchCount: batches.filter((batch) => batch.valid).length,
    activeReadingCount: activeBatch?.expectedPointCodes.length ?? 0,
  };
}

/** 缺测 / 重复批次的无效提示文案 */
export function invalidBatchHint(batch: ReadingBatch | null): string {
  if (!batch || batch.valid) return '';
  const parts: string[] = [];
  if (batch.missingPointCodes.length > 0) parts.push(`缺测 ${batch.missingPointCodes.join('、')}`);
  if (batch.duplicatePointCodes.length > 0) parts.push(`重复 ${batch.duplicatePointCodes.join('、')}`);
  if (batch.readings.length === 0) return '本批没有任何读数';
  const head = parts.length > 0 ? parts.join('，') : '测点不完整';
  return `批次 ${batch.recordedAt} ${head}，判定无效，本批不参与复核，沿用上一批有效结果`;
}

/**
 * 到位判断拦截：顶升中推进到已到位前，
 * 当前有效批次同步偏差达到 1.5mm，或任一测点达到位移限位 / 应力关注值时拦住。
 * 无有效批次时同样拦截，避免错误放行。
 */
export function evaluateArrivalGate(evaluation: StepBatchEvaluation): ArrivalGate {
  const batch = evaluation.activeBatch;
  if (!batch) {
    const latest = evaluation.latestBatch;
    const reasons: string[] = [];
    if (latest && !latest.valid) {
      reasons.push(`${invalidBatchHint(latest)}；此前没有其他有效批次可沿用`);
    } else {
      reasons.push('当前没有覆盖全部应有测点的有效复核批次，不能判定已到位');
    }
    return { blocked: true, noValidBatch: true, reasons, items: [], batchRecordedAt: latest?.recordedAt ?? null };
  }

  const reasons: string[] = [];
  const items: ArrivalBlockItem[] = [];
  const deviation = batch.syncDeviationMm ?? 0;
  if (deviation >= SYNC_TOLERANCE_MM) {
    reasons.push(
      `批次 ${batch.recordedAt} 同步偏差 ${deviation.toFixed(2)} mm 达到 ${SYNC_TOLERANCE_MM} mm 限值`,
    );
  }
  for (const breach of batch.breaches) {
    const labels: string[] = [];
    if (breach.displacementLimit) {
      labels.push(`位移 ${breach.displacementMm.toFixed(2)} mm 达到位移限位`);
    }
    if (breach.stressAlert) {
      labels.push(`应力 ${breach.stressMpa.toFixed(2)} MPa 达到应力关注值 ${STRESS_ALERT_MPA} MPa`);
    }
    items.push({ pointCode: breach.pointCode, items: labels });
    reasons.push(`批次 ${batch.recordedAt} 测点 ${breach.pointCode}：${labels.join('，')}`);
  }

  return {
    blocked: reasons.length > 0,
    noValidBatch: false,
    reasons,
    items,
    batchRecordedAt: batch.recordedAt,
  };
}

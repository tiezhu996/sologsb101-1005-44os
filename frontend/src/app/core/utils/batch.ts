/**
 * 顶升复核批次分析（整批快照口径）
 *
 * - 同一步骤、同一记录时间的读数归为一批复核；
 * - 平均值、同步偏差、超限统计与到位判断只认「最近一个覆盖全部应有测点的批次」；
 * - 缺测批次判为无效，沿用上一个有效批次的结果；
 * - 一律按整批快照取值，不跨批拼接各测点最新值（避免已纠正的异常点被旧数据掩盖）。
 */
import type { SyncRequirement } from '../types/step';
import type { Reading } from '../types/reading';
import { meanDisplacement, syncDeviationMm } from '../types/reading';
import {
  STRESS_TOLERANCE_MPA,
  SYNC_TOLERANCE_MM,
  limitLevel,
  stressLevel,
  syncLevel,
  type ToleranceLevel,
} from './tolerance';

/** 按同步要求布置的应有测点编号 */
export function expectedPointCodes(requirement: SyncRequirement): string[] {
  return requirement === 'single' ? ['P1'] : ['P1', 'P2', 'P3', 'P4'];
}

/** 单个测点的超限判定项 */
export interface PointViolation {
  pointCode: string;
  displacementMm: number;
  stressMpa: number;
  /** 位移是否达到限位（含临界） */
  displacementLimit: boolean;
  /** 应力是否达到关注值（含临界） */
  stressAlert: boolean;
  /** 超限明细（用于拦截说明） */
  items: string[];
}

/** 复核批次（同一记录时间的一批读数） */
export interface ReviewBatch {
  stepId: string;
  recordedAt: string;
  rows: Reading[];
  /** 应有测点 */
  expectedPoints: string[];
  /** 本批实际覆盖的测点 */
  coveredPoints: string[];
  /** 缺测测点 */
  missingPoints: string[];
  /** 是否覆盖全部应有测点（有效批的前提） */
  complete: boolean;
  /** 批内是否出现同测点重复记录（无法唯一确定快照，同样判无效） */
  duplicated: boolean;
  /** 仅当 complete && !duplicated 时有效 */
  valid: boolean;
  /** 平均位移（mm，无效批仍给出参考值，但不用于判定） */
  averageMm: number;
  /** 同步偏差（mm，最大位移 − 最小位移） */
  syncDeviationMm: number;
  /** 各测点判定 */
  violations: PointViolation[];
  /** 超限测点数（达到限位或应力关注值） */
  exceedCount: number;
  /** 关注档测点数 */
  watchCount: number;
  /** 正常测点数 */
  okCount: number;
  /** 综合等级（同步偏差 + 各测点取最严） */
  level: ToleranceLevel;
}

/** 步骤批次分析结果 */
export interface StepBatchAnalysis {
  /** 全部批次，按记录时间从新到旧 */
  batches: ReviewBatch[];
  /** 最近一批（无论是否有效），无读数时为 null */
  latestBatch: ReviewBatch | null;
  /** 当前有效批次：最近一个覆盖全部应有测点的批次；无则 null，沿用上一批结果 */
  effectiveBatch: ReviewBatch | null;
}

/** 到位拦截结论 */
export interface ArrivalGate {
  /** 是否放行推进到「已到位」 */
  allowed: boolean;
  /** 拦截 / 提示标题 */
  title: string;
  /** 逐条拦截原因（批次、测点、超限项） */
  reasons: string[];
  /** 缺测提示（最新一批无效时给出） */
  latestInvalidNote: string;
}

/** 带阈值的单批评定 */
function buildReviewBatch(
  stepId: string,
  recordedAt: string,
  rows: Reading[],
  expectedPoints: string[],
  limitMm: number,
): ReviewBatch {
  const coveredSet = new Set(rows.map((item) => item.pointCode));
  const missingPoints = expectedPoints.filter((code) => !coveredSet.has(code));
  const duplicated = rows.length !== coveredSet.size;
  const complete = missingPoints.length === 0;
  const valid = complete && !duplicated;

  let exceedCount = 0;
  let watchCount = 0;
  let okCount = 0;

  const violations: PointViolation[] = rows.map((row) => {
    const items: string[] = [];
    const dLevel = limitMm > 0 ? limitLevel(row.displacementMm, limitMm) : 'ok';
    const sLevel = stressLevel(row.stressMpa);
    const displacementLimit = dLevel === 'exceed';
    const stressAlert = sLevel === 'exceed';
    if (displacementLimit) {
      items.push(`位移 ${row.displacementMm.toFixed(2)} mm 达到/超过限位 ${limitMm} mm`);
    }
    if (stressAlert) {
      items.push(`应力 ${row.stressMpa.toFixed(2)} MPa 达到/超过关注值 ${STRESS_TOLERANCE_MPA} MPa`);
    }
    const level: ToleranceLevel =
      dLevel === 'exceed' || sLevel === 'exceed'
        ? 'exceed'
        : dLevel === 'watch' || sLevel === 'watch'
          ? 'watch'
          : 'ok';
    if (level === 'exceed') exceedCount += 1;
    else if (level === 'watch') watchCount += 1;
    else okCount += 1;
    return {
      pointCode: row.pointCode,
      displacementMm: row.displacementMm,
      stressMpa: row.stressMpa,
      displacementLimit,
      stressAlert,
      items,
    };
  });

  let level: ToleranceLevel = syncLevel(syncDeviationMm(rows));
  if (violations.some((item) => item.displacementLimit || item.stressAlert)) {
    level = 'exceed';
  } else if (
    level !== 'watch' &&
    violations.some(
      (item) =>
        (limitMm > 0 && Math.abs(item.displacementMm) >= limitMm * 0.8) ||
        item.stressMpa >= STRESS_TOLERANCE_MPA * 0.8,
    )
  ) {
    level = 'watch';
  }

  return {
    stepId,
    recordedAt,
    rows,
    expectedPoints,
    coveredPoints: [...coveredSet],
    missingPoints,
    complete,
    duplicated,
    valid,
    averageMm: meanDisplacement(rows),
    syncDeviationMm: syncDeviationMm(rows),
    violations,
    exceedCount,
    watchCount,
    okCount,
    level,
  };
}

/**
 * 分组一个步骤下的全部复核批次，按记录时间从新到旧排列；
 * 并标定最近的有效批次（覆盖全部应有测点、无重复测点）。
 */
export function analyzeStepBatches(
  stepId: string,
  requirement: SyncRequirement,
  readings: Reading[],
  limitMm: number,
): StepBatchAnalysis {
  const expectedPoints = expectedPointCodes(requirement);
  const groups = new Map<string, Reading[]>();
  for (const reading of readings) {
    if (reading.stepId !== stepId) continue;
    const list = groups.get(reading.recordedAt) ?? [];
    list.push(reading);
    groups.set(reading.recordedAt, list);
  }

  const batches = [...groups.entries()]
    .map(([recordedAt, rows]) => buildReviewBatch(stepId, recordedAt, rows, expectedPoints, limitMm))
    .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));

  const latestBatch = batches[0] ?? null;
  const effectiveBatch = batches.find((batch) => batch.valid) ?? null;

  return { batches, latestBatch, effectiveBatch };
}

/**
 * 到位闸门：顶升中 → 已到位 前的强制复核。
 * 只看当前有效批次（最近一个覆盖全部应有测点的复核）：
 * - 同步偏差达到 1.5 mm；
 * - 任一测点达到位移限位或应力关注值；
 * 出现任一项即拦截，并写明批次、测点与超限项。
 * 最新一批缺测无效时给出提示，判定沿用上一批有效结果。
 */
export function evaluateArrivalGate(
  analysis: StepBatchAnalysis,
  context: { seq: number; bridgeName: string; limitMm: number },
): ArrivalGate {
  const reasons: string[] = [];
  let latestInvalidNote = '';

  const { latestBatch, effectiveBatch } = analysis;
  if (latestBatch && !latestBatch.valid) {
    const flaws: string[] = [];
    if (latestBatch.missingPoints.length > 0) {
      flaws.push(`缺测测点 ${latestBatch.missingPoints.join('、')}`);
    }
    if (latestBatch.duplicated) flaws.push('存在同测点重复记录');
    latestInvalidNote =
      `最新一批复核（${latestBatch.recordedAt}）${flaws.join('、')}，批次无效，` +
      `判定沿用上一有效批次（${effectiveBatch ? effectiveBatch.recordedAt : '尚无有效批次'}）`;
  }

  const batchLabel = (batch: ReviewBatch): string =>
    `步骤 #${context.seq} ${context.bridgeName}，复核批次 ${batch.recordedAt}`;

  if (!effectiveBatch) {
    reasons.push(
      '尚无覆盖全部应有测点的有效复核批次' +
        (latestBatch ? `（最新批次 ${latestBatch.recordedAt} 缺测/重复，判无效）` : '（该步骤还没有任何读数）'),
    );
    return {
      allowed: false,
      title: '禁止推进为「已到位」：缺少有效复核批次',
      reasons,
      latestInvalidNote,
    };
  }

  if (effectiveBatch.syncDeviationMm >= SYNC_TOLERANCE_MM) {
    reasons.push(
      `${batchLabel(effectiveBatch)}：同步偏差 ${effectiveBatch.syncDeviationMm.toFixed(2)} mm ` +
        `达到/超过允许值 ${SYNC_TOLERANCE_MM} mm，需先调平`,
    );
  }

  for (const item of effectiveBatch.violations) {
    if (item.displacementLimit || item.stressAlert) {
      reasons.push(`${batchLabel(effectiveBatch)}：测点 ${item.pointCode} ${item.items.join('；')}`);
    }
  }

  if (reasons.length > 0) {
    return {
      allowed: false,
      title: '禁止推进为「已到位」：当前有效复核批次超限',
      reasons,
      latestInvalidNote,
    };
  }

  return {
    allowed: true,
    title: '复核通过，可推进为「已到位」',
    reasons: [],
    latestInvalidNote,
  };
}

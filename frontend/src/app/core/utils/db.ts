/**
 * IndexedDB 持久化层（Dexie 封装）· 桥梁支座更换与顶升监测台
 * - 数据结构版本号 + 升级迁移逻辑
 * - 各实体表增删改查（含级联删除）
 * - 首屏自动播种互相引用的演示数据（桥梁 → 墩台 → 支座 / 顶升步骤 → 测点读数 / 分步验收）
 * 纯前端应用：不依赖任何后端或数据库服务
 */
import Dexie, { type Table } from 'dexie';
import type { Bridge } from '../types/bridge';
import type { Pier } from '../types/pier';
import type { Bearing, DiseaseGrade } from '../types/bearing';
import type { Step, SyncRequirement } from '../types/step';
import type { Reading } from '../types/reading';
import type { Acceptance, AcceptanceStage } from '../types/acceptance';
import { ROW_REVISION, type Revisioned } from '../types/persistence';

/** 浏览器 IndexedDB 库名 */
export const DB_NAME = 'gbbridgebear';

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 2;

export { ROW_REVISION };
export type { Revisioned };

export type BridgeRow = Bridge;
export type PierRow = Pier;
export type BearingRow = Bearing;
export type StepRow = Step;
export type ReadingRow = Reading;
export type AcceptanceRow = Acceptance;

class BridgeBearingDatabase extends Dexie {
  bridges!: Table<BridgeRow, string>;
  piers!: Table<PierRow, string>;
  bearings!: Table<BearingRow, string>;
  steps!: Table<StepRow, string>;
  readings!: Table<ReadingRow, string>;
  acceptances!: Table<AcceptanceRow, string>;
  settings!: Table<{ id: string; value: string; updatedAt: string }, string>;

  constructor() {
    super(DB_NAME);

    // v1：初版结构（保留历史数据）
    this.version(1).stores({
      bridges: 'id, name, bridgeType, builtYear',
      piers: 'id, bridgeId, code',
      bearings: 'id, pierId, diseaseGrade, type',
      steps: 'id, bridgeId, seq, state',
      readings: 'id, stepId, pointCode',
      acceptances: 'id, bearingId, stage, conclusion',
    });

    // v2：新增 revision 行修订号；支座补充组合索引便于按墩台批量评级，
    //     顶升步骤补充同步要求索引，验收补充组合索引，并新增 settings 表
    this.version(DB_SCHEMA_VERSION)
      .stores({
        bridges: 'id, name, bridgeType, builtYear, roadClass, archived',
        piers: 'id, bridgeId, code, capElevation, [bridgeId+code]',
        bearings: 'id, pierId, diseaseGrade, type, serial, [pierId+serial]',
        steps: 'id, bridgeId, seq, state, syncRequirement, [bridgeId+seq]',
        readings: 'id, stepId, pointCode, recordedAt, [stepId+pointCode]',
        acceptances: 'id, bearingId, stage, conclusion, [bearingId+stage]',
        settings: 'id',
      })
      .upgrade(async (tx) => {
        const tables: Array<Table<Record<string, unknown>, string>> = [
          tx.table('bridges'),
          tx.table('piers'),
          tx.table('bearings'),
          tx.table('steps'),
          tx.table('readings'),
          tx.table('acceptances'),
        ];
        for (const table of tables) {
          await table.toCollection().modify((row: Record<string, unknown>) => {
            row.revision = ROW_REVISION;
            if (typeof row.createdAt !== 'string') row.createdAt = new Date().toISOString();
          });
        }
        // 迁移：旧版桥梁缺少 archived 字段
        await tx.table('bridges').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.archived !== 'boolean') row.archived = false;
          if (typeof row.spanCombo !== 'string' && typeof row.span === 'string') row.spanCombo = row.span;
        });
        // 迁移：旧版支座字段 grade → diseaseGrade
        await tx.table('bearings').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.diseaseGrade !== 'string' && typeof row.grade === 'string') {
            row.diseaseGrade = row.grade;
          }
          if (typeof row.diseaseNote !== 'string') row.diseaseNote = '';
        });
        // 迁移：旧版步骤字段 syncType → syncRequirement，limit → limitMm
        await tx.table('steps').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.syncRequirement !== 'string' && typeof row.syncType === 'string') {
            row.syncRequirement = row.syncType;
          }
          if (typeof row.limitMm !== 'number' && typeof row.limit === 'number') row.limitMm = row.limit;
          if (typeof row.targetLiftMm !== 'number' && typeof row.lift === 'number') row.targetLiftMm = row.lift;
        });
      });
  }
}

export const db = new BridgeBearingDatabase();

/* ============================== 演示数据播种 ============================== */

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function dateTimeText(offsetDays: number, hour: number, minute: number): string {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(hour)}:${pad(minute)}`;
}

interface SeedBridgeSpec {
  name: string;
  spanCombo: string;
  bridgeType: Bridge['bridgeType'];
  builtYear: number;
  roadClass: Bridge['roadClass'];
  piers: Array<{
    code: string;
    capElevation: number;
    type: Pier['type'];
    bearings: Array<{ serial: string; type: Bearing['type']; spec: string; grade: DiseaseGrade; note: string }>;
  }>;
  steps: Array<{ targetLiftMm: number; sync: SyncRequirement; limitMm: number; leader: string; state: Step['state'] }>;
}

const SEED_BRIDGES: SeedBridgeSpec[] = [
  {
    name: '沙河大桥',
    spanCombo: '3×30m',
    bridgeType: 'beam',
    builtYear: 2006,
    roadClass: 'expressway',
    piers: [
      {
        code: '0#台',
        capElevation: 42.35,
        type: 'abutment',
        bearings: [
          { serial: '1', type: 'plate', spec: 'GJZ 300×400', grade: 'moderate', note: '支座剪切变形 8mm，垫石局部破损' },
          { serial: '2', type: 'plate', spec: 'GJZ 300×400', grade: 'slight', note: '表面轻微老化开裂' },
        ],
      },
      {
        code: '1#墩',
        capElevation: 41.12,
        type: 'pier',
        bearings: [
          { serial: '1', type: 'pot', spec: 'GPZ 2000', grade: 'severe', note: '上座板锈蚀严重，位移超限' },
          { serial: '2', type: 'pot', spec: 'GPZ 2000', grade: 'intact', note: '状态完好' },
          { serial: '3', type: 'pot', spec: 'GPZ 2000', grade: 'moderate', note: '防尘罩破损，滑板外露' },
        ],
      },
      {
        code: '2#墩',
        capElevation: 40.86,
        type: 'pier',
        bearings: [
          { serial: '1', type: 'spherical', spec: 'GQZ 3000', grade: 'slight', note: '转动轻微异响' },
          { serial: '2', type: 'spherical', spec: 'GQZ 3000', grade: 'severe', note: '球冠板裂纹，需更换' },
        ],
      },
    ],
    steps: [
      { targetLiftMm: 3, sync: 'sync', limitMm: 12, leader: '陈立强', state: 'arrived' },
      { targetLiftMm: 4, sync: 'cross', limitMm: 12, leader: '陈立强', state: 'lifting' },
      { targetLiftMm: 5, sync: 'single', limitMm: 15, leader: '赵启明', state: 'idle' },
    ],
  },
  {
    name: '云溪河特大桥',
    spanCombo: '5×40m',
    bridgeType: 'arch',
    builtYear: 2013,
    roadClass: 'first',
    piers: [
      {
        code: '0#台',
        capElevation: 58.2,
        type: 'abutment',
        bearings: [
          { serial: '1', type: 'pot', spec: 'GPZ 3000', grade: 'intact', note: '状态完好' },
          { serial: '2', type: 'pot', spec: 'GPZ 3000', grade: 'moderate', note: '位移标尺脱落，需复核' },
        ],
      },
      {
        code: '1#墩',
        capElevation: 57.44,
        type: 'transition',
        bearings: [
          { serial: '1', type: 'spherical', spec: 'GQZ 4000', grade: 'severe', note: '支座脱空 3mm，顶升更换' },
          { serial: '2', type: 'spherical', spec: 'GQZ 4000', grade: 'moderate', note: '滑板磨损，摩擦系数偏大' },
        ],
      },
    ],
    steps: [
      { targetLiftMm: 4, sync: 'sync', limitMm: 10, leader: '赵启明', state: 'lifting' },
      { targetLiftMm: 6, sync: 'cross', limitMm: 10, leader: '赵启明', state: 'idle' },
    ],
  },
];

/** 播种用复核批次测点值 */
interface SeedPoint {
  code: string;
  disp: number;
  stress: number;
}
interface SeedBatch {
  /** 整批同一记录时间 */
  recordedAt: string;
  points: SeedPoint[];
}

/**
 * 显式编排的复核读数（key = 桥梁序号-步骤序号）：
 * - 1-1 已到位：三批完整有效，偏差均在允许值内；
 * - 1-2 顶升中：最新一批缺 P4 判无效，沿用上一有效批次，可继续推进；
 * - 2-1 顶升中：最新有效批同步偏差超 1.5 mm 且 P3 应力达关注值，推进到位被拦截。
 */
const SEED_READING_BATCHES: Record<string, SeedBatch[]> = {
  '1-1': [
    {
      recordedAt: dateTimeText(0, 9, 5),
      points: [
        { code: 'P1', disp: 0.78, stress: 8.2 },
        { code: 'P2', disp: 0.82, stress: 8.5 },
        { code: 'P3', disp: 0.75, stress: 8.1 },
        { code: 'P4', disp: 0.8, stress: 8.4 },
      ],
    },
    {
      recordedAt: dateTimeText(0, 9, 20),
      points: [
        { code: 'P1', disp: 1.52, stress: 8.8 },
        { code: 'P2', disp: 1.58, stress: 9.0 },
        { code: 'P3', disp: 1.48, stress: 8.6 },
        { code: 'P4', disp: 1.55, stress: 8.9 },
      ],
    },
    {
      recordedAt: dateTimeText(0, 9, 35),
      points: [
        { code: 'P1', disp: 2.96, stress: 9.2 },
        { code: 'P2', disp: 3.02, stress: 9.5 },
        { code: 'P3', disp: 2.98, stress: 9.1 },
        { code: 'P4', disp: 3.04, stress: 9.4 },
      ],
    },
  ],
  '1-2': [
    {
      recordedAt: dateTimeText(0, 10, 5),
      points: [
        { code: 'P1', disp: 1.02, stress: 8.4 },
        { code: 'P2', disp: 1.08, stress: 8.7 },
        { code: 'P3', disp: 0.98, stress: 8.3 },
        { code: 'P4', disp: 1.05, stress: 8.6 },
      ],
    },
    {
      recordedAt: dateTimeText(0, 10, 20),
      points: [
        { code: 'P1', disp: 2.05, stress: 9.0 },
        { code: 'P2', disp: 2.12, stress: 9.3 },
        { code: 'P3', disp: 1.98, stress: 8.8 },
        { code: 'P4', disp: 2.08, stress: 9.1 },
      ],
    },
    {
      // 最新复核缺测 P4：批次无效，平均值/偏差/到位判断沿用 10:20 有效批次
      recordedAt: dateTimeText(0, 10, 35),
      points: [
        { code: 'P1', disp: 3.12, stress: 9.4 },
        { code: 'P2', disp: 4.35, stress: 9.8 },
        { code: 'P3', disp: 3.05, stress: 9.2 },
      ],
    },
  ],
  '2-1': [
    {
      recordedAt: dateTimeText(0, 9, 10),
      points: [
        { code: 'P1', disp: 1.24, stress: 8.6 },
        { code: 'P2', disp: 1.3, stress: 8.9 },
        { code: 'P3', disp: 1.2, stress: 12.4 },
        { code: 'P4', disp: 1.28, stress: 9.0 },
      ],
    },
    {
      recordedAt: dateTimeText(0, 9, 25),
      points: [
        { code: 'P1', disp: 2.62, stress: 9.2 },
        { code: 'P2', disp: 2.7, stress: 9.5 },
        { code: 'P3', disp: 2.58, stress: 9.0 },
        { code: 'P4', disp: 2.66, stress: 9.4 },
      ],
    },
    {
      // 最新有效批：P2 偏高致极差 2.06 mm（≥1.5），且 P3 应力 12.6 MPa 达关注值 → 拦截到位
      recordedAt: dateTimeText(0, 9, 40),
      points: [
        { code: 'P1', disp: 3.58, stress: 9.8 },
        { code: 'P2', disp: 5.64, stress: 10.2 },
        { code: 'P3', disp: 3.62, stress: 12.6 },
        { code: 'P4', disp: 3.7, stress: 10.0 },
      ],
    },
  ],
};

/**
 * 播种：2 座桥梁 × 各 2~3 个墩台 × 各 2~3 个支座 + 顶升步骤 + 每步测点读数 + 分步验收。
 * 数据父子互相引用（bridgeId / pierId / bearingId / stepId），全部页面打开即有内容。
 */
async function seedDatabase(): Promise<void> {
  const stamp = new Date().toISOString();

  const bridges: BridgeRow[] = [];
  const piers: PierRow[] = [];
  const bearings: BearingRow[] = [];
  const steps: StepRow[] = [];
  const readings: ReadingRow[] = [];
  const acceptances: AcceptanceRow[] = [];

  const operators = ['陈立强', '赵启明', '李清和', '周文斌'];
  const acceptors = ['王监理', '李总监'];

  SEED_BRIDGES.forEach((bridgeSpec, bridgeIndex) => {
    const bridgeId = `bridge-${bridgeIndex + 1}`;
    bridges.push({
      id: bridgeId,
      name: bridgeSpec.name,
      spanCombo: bridgeSpec.spanCombo,
      bridgeType: bridgeSpec.bridgeType,
      builtYear: bridgeSpec.builtYear,
      roadClass: bridgeSpec.roadClass,
      archived: false,
      createdAt: stamp,
      revision: ROW_REVISION,
    });

    bridgeSpec.piers.forEach((pierSpec, pierIndex) => {
      const pierId = `pier-${bridgeIndex + 1}-${pierIndex + 1}`;
      piers.push({
        id: pierId,
        bridgeId,
        code: pierSpec.code,
        capElevation: pierSpec.capElevation,
        type: pierSpec.type,
        bearingCount: pierSpec.bearings.length,
        createdAt: stamp,
        revision: ROW_REVISION,
      });

      pierSpec.bearings.forEach((bearingSpec, bearingIndex) => {
        const bearingId = `bearing-${bridgeIndex + 1}-${pierIndex + 1}-${bearingIndex + 1}`;
        bearings.push({
          id: bearingId,
          pierId,
          serial: bearingSpec.serial,
          type: bearingSpec.type,
          spec: bearingSpec.spec,
          diseaseGrade: bearingSpec.grade,
          diseaseNote: bearingSpec.note,
          createdAt: stamp,
          revision: ROW_REVISION,
        });

        // 验收：完好 / 轻微支座完成前两步，其余按序推进
        const passedCount =
          bearingSpec.grade === 'intact' ? 4 : bearingSpec.grade === 'slight' ? 2 : bearingSpec.grade === 'moderate' ? 1 : 0;
        const stageList: AcceptanceStage[] = ['lifted', 'bearingPlaced', 'beamLowered', 'completed'];
        for (let stageIndex = 0; stageIndex < passedCount; stageIndex += 1) {
          acceptances.push({
            id: `acc-${bearingId}-${stageIndex + 1}`,
            bearingId,
            stage: stageList[stageIndex],
            conclusion: 'pass',
            acceptor: acceptors[stageIndex % acceptors.length],
            acceptedAt: dateTimeText(-3 + stageIndex, 10 + stageIndex, 30),
            createdAt: stamp,
            revision: ROW_REVISION,
          });
        }
      });
    });

    bridgeSpec.steps.forEach((stepSpec, stepIndex) => {
      const stepId = `step-${bridgeIndex + 1}-${stepIndex + 1}`;
      steps.push({
        id: stepId,
        bridgeId,
        seq: stepIndex + 1,
        targetLiftMm: stepSpec.targetLiftMm,
        syncRequirement: stepSpec.sync,
        limitMm: stepSpec.limitMm,
        leader: stepSpec.leader,
        state: stepSpec.state,
        createdAt: stamp,
        revision: ROW_REVISION,
      });

      // 未开始的步骤不产生读数
      if (stepSpec.state === 'idle') return;

      // 同一步骤、同一记录时间的读数构成一批复核（整批快照口径）。
      // 读数按桥梁 + 步骤显式编排，覆盖：有效批通过、最新批缺测沿用上一批、有效批超限拦截。
      const pointCount = stepSpec.sync === 'single' ? 1 : 4;
      const seedBatches = SEED_READING_BATCHES[`${bridgeIndex + 1}-${stepIndex + 1}`] ?? [];
      seedBatches.forEach((batch, batchIndex) => {
        batch.points.forEach((point) => {
          readings.push({
            id: `read-${stepId}-${batchIndex + 1}-${point.code}`,
            stepId,
            pointCode: point.code,
            displacementMm: point.disp,
            stressMpa: point.stress,
            recordedAt: batch.recordedAt,
            operator: operators[(stepIndex + batchIndex) % operators.length],
            createdAt: stamp,
            revision: ROW_REVISION,
          });
        });
      });

      // 兜底：未显式编排的步骤给两轮完整有效批次，保证页面有数据
      if (seedBatches.length === 0) {
        const rounds = stepSpec.state === 'arrived' ? 3 : 2;
        for (let round = 0; round < rounds; round += 1) {
          const recordedAt = dateTimeText(0, 9 + round, 5);
          for (let point = 0; point < pointCount; point += 1) {
            const base = stepSpec.targetLiftMm * ((round + 1) / (rounds + 1));
            readings.push({
              id: `read-${stepId}-${round + 1}-${point + 1}`,
              stepId,
              pointCode: `P${point + 1}`,
              displacementMm: Number((base + (point - 1.5) * 0.05).toFixed(2)),
              stressMpa: Number((8 + point * 0.5).toFixed(2)),
              recordedAt,
              operator: operators[(stepIndex + round) % operators.length],
              createdAt: stamp,
              revision: ROW_REVISION,
            });
          }
        }
      }
    });
  });

  await db.transaction(
    'rw',
    [db.bridges, db.piers, db.bearings, db.steps, db.readings, db.acceptances],
    async () => {
      await db.bridges.bulkPut(bridges);
      await db.piers.bulkPut(piers);
      await db.bearings.bulkPut(bearings);
      await db.steps.bulkPut(steps);
      await db.readings.bulkPut(readings);
      await db.acceptances.bulkPut(acceptances);
    },
  );
}

/* ============================== 初始化 ============================== */

/** 打开数据库；桥梁表为空时播种演示数据（幂等） */
export async function initDatabase(): Promise<void> {
  await db.open();
  const count = await db.bridges.count();
  if (count === 0) {
    await seedDatabase();
  }
}

/* ============================== 桥梁 ============================== */

export async function listBridges(): Promise<BridgeRow[]> {
  return db.bridges.toArray();
}

export async function putBridge(row: BridgeRow): Promise<void> {
  await db.bridges.put(row);
}

/** 删除桥梁并级联清理墩台 / 支座 / 步骤 / 读数 / 验收 */
export async function removeBridge(id: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.bridges, db.piers, db.bearings, db.steps, db.readings, db.acceptances],
    async () => {
      const piers = await db.piers.where('bridgeId').equals(id).toArray();
      const pierIds = piers.map((item) => item.id);
      const bearingRows = pierIds.length ? await db.bearings.where('pierId').anyOf(pierIds).toArray() : [];
      const bearingIds = bearingRows.map((item) => item.id);
      const stepRows = await db.steps.where('bridgeId').equals(id).toArray();
      const stepIds = stepRows.map((item) => item.id);
      if (bearingIds.length) await db.acceptances.where('bearingId').anyOf(bearingIds).delete();
      if (stepIds.length) await db.readings.where('stepId').anyOf(stepIds).delete();
      await db.steps.where('bridgeId').equals(id).delete();
      if (pierIds.length) await db.bearings.where('pierId').anyOf(pierIds).delete();
      await db.piers.where('bridgeId').equals(id).delete();
      await db.bridges.delete(id);
    },
  );
}

/* ============================== 墩台 ============================== */

export async function listPiers(): Promise<PierRow[]> {
  return db.piers.toArray();
}

export async function putPier(row: PierRow): Promise<void> {
  await db.piers.put(row);
}

export async function removePier(id: string): Promise<void> {
  await db.transaction('rw', [db.piers, db.bearings, db.acceptances], async () => {
    const bearingRows = await db.bearings.where('pierId').equals(id).toArray();
    const bearingIds = bearingRows.map((item) => item.id);
    if (bearingIds.length) await db.acceptances.where('bearingId').anyOf(bearingIds).delete();
    await db.bearings.where('pierId').equals(id).delete();
    await db.piers.delete(id);
  });
}

/* ============================== 支座 ============================== */

export async function listBearings(): Promise<BearingRow[]> {
  return db.bearings.toArray();
}

export async function putBearing(row: BearingRow): Promise<void> {
  await db.bearings.put(row);
}

export async function putBearings(rows: BearingRow[]): Promise<void> {
  await db.bearings.bulkPut(rows);
}

export async function removeBearing(id: string): Promise<void> {
  await db.transaction('rw', [db.bearings, db.acceptances], async () => {
    await db.acceptances.where('bearingId').equals(id).delete();
    await db.bearings.delete(id);
  });
}

/* ============================ 顶升步骤 ============================ */

export async function listSteps(): Promise<StepRow[]> {
  const rows = await db.steps.toArray();
  return rows.sort((a, b) => a.seq - b.seq);
}

export async function putStep(row: StepRow): Promise<void> {
  await db.steps.put(row);
}

export async function putSteps(rows: StepRow[]): Promise<void> {
  await db.steps.bulkPut(rows);
}

export async function removeStep(id: string): Promise<void> {
  await db.transaction('rw', [db.steps, db.readings], async () => {
    await db.readings.where('stepId').equals(id).delete();
    await db.steps.delete(id);
  });
}

/* ============================ 测点读数 ============================ */

export async function listReadings(): Promise<ReadingRow[]> {
  return db.readings.toArray();
}

export async function putReading(row: ReadingRow): Promise<void> {
  await db.readings.put(row);
}

export async function putReadings(rows: ReadingRow[]): Promise<void> {
  await db.readings.bulkPut(rows);
}

export async function removeReading(id: string): Promise<void> {
  await db.readings.delete(id);
}

/* ============================= 验收 ============================= */

export async function listAcceptances(): Promise<AcceptanceRow[]> {
  return db.acceptances.toArray();
}

export async function putAcceptance(row: AcceptanceRow): Promise<void> {
  await db.acceptances.put(row);
}

export async function removeAcceptance(id: string): Promise<void> {
  await db.acceptances.delete(id);
}

/* ========================== 整库导入导出 ========================== */

export interface DatabaseSnapshot {
  name: string;
  schemaVersion: number;
  exportedAt: string;
  bridges: Bridge[];
  piers: Pier[];
  bearings: Bearing[];
  steps: Step[];
  readings: Reading[];
  acceptances: Acceptance[];
}

export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [bridges, piers, bearings, steps, readings, acceptances] = await Promise.all([
    listBridges(),
    listPiers(),
    listBearings(),
    listSteps(),
    listReadings(),
    listAcceptances(),
  ]);
  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    bridges,
    piers,
    bearings,
    steps,
    readings,
    acceptances,
  };
}

export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction(
    'rw',
    [db.bridges, db.piers, db.bearings, db.steps, db.readings, db.acceptances],
    async () => {
      await Promise.all([
        db.bridges.clear(),
        db.piers.clear(),
        db.bearings.clear(),
        db.steps.clear(),
        db.readings.clear(),
        db.acceptances.clear(),
      ]);
      await db.bridges.bulkPut(snapshot.bridges ?? []);
      await db.piers.bulkPut(snapshot.piers ?? []);
      await db.bearings.bulkPut(snapshot.bearings ?? []);
      await db.steps.bulkPut(snapshot.steps ?? []);
      await db.readings.bulkPut(snapshot.readings ?? []);
      await db.acceptances.bulkPut(snapshot.acceptances ?? []);
    },
  );
}

/** 清空并重新播种 */
export async function resetDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [db.bridges, db.piers, db.bearings, db.steps, db.readings, db.acceptances],
    async () => {
      await Promise.all([
        db.bridges.clear(),
        db.piers.clear(),
        db.bearings.clear(),
        db.steps.clear(),
        db.readings.clear(),
        db.acceptances.clear(),
      ]);
    },
  );
  await seedDatabase();
}

/** 各表行数统计 */
export async function countAll(): Promise<Record<string, number>> {
  const [bridges, piers, bearings, steps, readings, acceptances] = await Promise.all([
    db.bridges.count(),
    db.piers.count(),
    db.bearings.count(),
    db.steps.count(),
    db.readings.count(),
    db.acceptances.count(),
  ]);
  return { bridges, piers, bearings, steps, readings, acceptances };
}

/** 结构版本信息 */
export interface SchemaInfo {
  dbName: string;
  schemaVersion: number;
  rowRevision: number;
  today: string;
}

export function schemaInfo(): SchemaInfo {
  const now = new Date();
  return {
    dbName: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    rowRevision: ROW_REVISION,
    today: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
  };
}

/** 新建行通用字段 */
export function rowMeta(): { createdAt: string; revision: number } {
  return { createdAt: new Date().toISOString(), revision: ROW_REVISION };
}

/** 新建本地 id */
export function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

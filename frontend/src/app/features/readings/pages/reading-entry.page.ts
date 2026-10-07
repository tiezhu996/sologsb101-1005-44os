import { Component, computed, inject, signal, type Signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { Store } from '@ngrx/store';
import { toSignal } from '@angular/core/rxjs-interop';
import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatChipsModule } from '@angular/material/chips';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { STEP_STATE_LABEL, SYNC_REQUIREMENT_LABEL, type StepView } from '../../../core/types/step';
import {
  STRESS_ALERT_MPA,
  meanDisplacement,
  readingDateHint,
  suggestPointCodes,
  syncDeviationMm,
  type ReadingView,
} from '../../../core/types/reading';
import { ROUTES } from '../../../core/router/app.routes';
import { buildStepViews, selectStepStats } from '../../../core/store/step.selectors';
import { selectBridges } from '../../../core/store/bridge.selectors';
import { IdbTableService } from '../../../core/services/idb-table.service';
import { putReadings, rowMeta, newId, type ReadingRow } from '../../../core/utils/db';
import { formatMm, formatStress } from '../../../core/utils/unit';
import {
  TOLERANCE_HEX,
  TOLERANCE_LEVEL_LABEL,
  limitAlertText,
  overallLevel,
  syncAlertText,
  syncLevel,
  type ToleranceLevel,
} from '../../../core/utils/tolerance';
import {
  evaluateStepBatches,
  invalidBatchHint,
  type StepBatchEvaluation,
} from '../../../core/utils/reading-batch';
import { nowDateTime } from '../../../core/utils/export';
import { StatBadgeComponent } from '../../../shared/components/common/stat-badge.component';
import { EmptyPanelComponent } from '../../../shared/components/common/empty-panel.component';
import { FilterBarComponent, type FilterSelectSpec } from '../../../shared/components/common/filter-bar.component';
import type { BridgeRow, StepRow } from '../../../core/utils/db';

/** 批量录入的临时行 */
interface BatchRow {
  pointCode: string;
  displacementMm: number;
  stressMpa: number;
}

/**
 * /readings 测点读数录入
 * 按步骤批量录入位移与应力。批次口径：同一步骤、同一记录时间为一批（整批快照），
 * 原始记录全部保留；平均值 / 同步偏差 / 超限统计 / 到位判断只看最近一批覆盖全部
 * 应有测点的复核，缺测批次提示无效并沿用上一批有效结果。
 */
@Component({
  selector: 'app-reading-entry-page',
  standalone: true,
  imports: [
    FormsModule,
    MatCardModule,
    MatButtonModule,
    MatIconModule,
    MatChipsModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatSnackBarModule,
    MatTooltipModule,
    StatBadgeComponent,
    EmptyPanelComponent,
    FilterBarComponent,
  ],
  template: `
    <div class="page-head">
      <div>
        <h2 class="page-title">测点读数录入</h2>
        <div class="page-sub">
          同一步骤、同一记录时间的批量记录视为一批；平均值、同步偏差、超限统计与到位判断只看最近一批覆盖全部应有测点的复核。
        </div>
      </div>
      <div class="gb-inline-actions">
        <button mat-stroked-button (click)="go(ROUTES.steps)">
          <mat-icon>stairs</mat-icon>
          顶升步骤编排
        </button>
        <button mat-flat-button color="primary" [disabled]="batchRows().length === 0" (click)="submitBatch()">
          <mat-icon>save</mat-icon>
          提交 {{ batchRows().length }} 条读数
        </button>
      </div>
    </div>

    <div class="stat-grid">
      <app-stat-badge title="测点原始读数" [value]="stats().readingCount" [suffix]="'条'" color="#1565c0" />
      <app-stat-badge
        title="有效批次平均位移"
        [value]="currentAverageText()"
        color="#00897b"
        [hint]="activeBatchHint()"
      />
      <app-stat-badge
        title="有效批次同步偏差"
        [value]="currentDeviationText()"
        [percent]="deviationShare()"
        [color]="syncColor()"
        [hint]="'允许值 1.5 mm，当前 ' + syncLevelText() + '；' + activeBatchHint()"
      />
      <app-stat-badge
        title="有效批次超限测点"
        [value]="activeExceedCount()"
        [suffix]="'个'"
        color="#c62828"
        [hint]="'限位值 ' + (selectedStep()?.limitMm ?? 0) + ' mm，应力关注值 ' + stressAlert + ' MPa；只统计当前有效批次'"
      />
    </div>

    <app-filter-bar
      keywordLabel="关键字"
      keywordPlaceholder="按测点编号 / 记录人搜索"
      [keyword]="keyword()"
      [selects]="selects()"
      [values]="filters()"
      [resultCount]="filtered().length"
      countUnit="条读数"
      (keywordChange)="onKeyword($event)"
      (filtersChange)="onFilters($event)"
    >
      <button mat-stroked-button (click)="clearFilters()">
        <mat-icon>filter_alt_off</mat-icon>
        清空筛选
      </button>
    </app-filter-bar>

    <div class="gb-section">
      <mat-card appearance="outlined">
        <div style="padding: 12px 14px">
          <div class="gb-card-title">批量录入面板</div>
          <div class="gb-inline-actions" style="margin-top: 10px">
            <mat-form-field appearance="outline" style="min-width: 300px">
              <mat-label>顶升步骤</mat-label>
              <mat-select
                [ngModel]="selectedStepId()"
                (ngModelChange)="onStepChange($event)"
              >
                @for (step of stepViews(); track step.id) {
                  <mat-option [value]="step.id">
                    #{{ step.seq }} {{ step.bridgeName }} · 目标 {{ step.targetLiftMm }} mm ·
                    {{ syncRequirementLabel[step.syncRequirement] }} · {{ stepStateLabel[step.state] }}
                  </mat-option>
                }
              </mat-select>
            </mat-form-field>
            <mat-form-field appearance="outline" style="min-width: 190px">
              <mat-label>记录人</mat-label>
              <input matInput [ngModel]="operator()" (ngModelChange)="operator.set($event)" />
            </mat-form-field>
            <mat-form-field appearance="outline" style="min-width: 230px">
              <mat-label>记录时间（本批共用）</mat-label>
              <input
                matInput
                type="datetime-local"
                [ngModel]="recordedAt()"
                (ngModelChange)="recordedAt.set($event)"
              />
            </mat-form-field>
            <button mat-stroked-button (click)="regenerateRows()">
              <mat-icon>autorenew</mat-icon>
              重排测点
            </button>
            <button mat-stroked-button (click)="fillReference()">
              <mat-icon>functions</mat-icon>
              按目标顶升量填参考值
            </button>
          </div>
          <div class="gb-hint">{{ dateHint() }}</div>
          @if (existingBatchAt()) {
            <div class="gb-hint" style="color: #ed6c02">
              <mat-icon style="font-size: 14px; width: 14px; height: 14px; vertical-align: -2px">warning</mat-icon>
              该步骤在 {{ existingBatchAt() }} 已有一批记录，提交后将作为更晚的新批次；上一批原始记录仍保留。
            </div>
          }

          @if (selectedStep(); as step) {
            <div class="gb-table-wrap" style="margin-top: 10px">
              <table class="gb-table">
                <thead>
                  <tr>
                    <th style="width: 120px">测点编号</th>
                    <th style="width: 190px">位移（mm）</th>
                    <th style="width: 190px">应力（MPa）</th>
                    <th>判定</th>
                  </tr>
                </thead>
                <tbody>
                  @for (row of batchRows(); track row.pointCode) {
                    <tr>
                      <td class="gb-mono">{{ row.pointCode }}</td>
                      <td>
                        <input
                          class="gb-input"
                          type="number"
                          step="0.01"
                          [ngModel]="row.displacementMm"
                          (ngModelChange)="updateRow(row.pointCode, 'displacementMm', $event)"
                        />
                      </td>
                      <td>
                        <input
                          class="gb-input"
                          type="number"
                          step="0.01"
                          [ngModel]="row.stressMpa"
                          (ngModelChange)="updateRow(row.pointCode, 'stressMpa', $event)"
                        />
                      </td>
                      <td>
                        <span [style.color]="rowColor(row)">
                          {{ rowLevelText(row) }}
                        </span>
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
            <div class="gb-timeline" style="margin-top: 10px">
              <div
                class="gb-timeline-node"
                [class.is-exceed]="batchDeviationLevel() === 'exceed'"
                [class.is-watch]="batchDeviationLevel() === 'watch'"
              >
                <div>{{ syncAlertText(batchDeviation(), syncRequirementLabel[step.syncRequirement]) }}</div>
                <div class="gb-hint">
                  本批 {{ batchRows().length }} 个测点，平均位移 {{ formatMm(batchAverage()) }}；{{ limitAlertText(batchMax(), step.limitMm) }}
                </div>
              </div>
            </div>
          } @else {
            <app-empty-panel
              title="请选择顶升步骤"
              description="先在顶升步骤编排页创建步骤，再回到本页批量录入测点读数。"
              icon="monitor_heart"
              actionLabel="去编排步骤"
              (action)="go(ROUTES.steps)"
            />
          }
        </div>
      </mat-card>
    </div>

    @if (selectedEvaluation(); as evaluation) {
      <div class="gb-section">
        <mat-card appearance="outlined" [style.border-color]="evaluation.withoutValidBatch ? '#c62828' : evaluation.stale ? '#ed6c02' : undefined">
          <div style="padding: 12px 14px">
            <div class="gb-card-title">
              当前有效批次复核
              @if (evaluation.activeBatch; as batch) {
                <span class="gb-mono" style="margin-left: 8px; font-size: 13px">{{ batch.recordedAt }}</span>
              }
            </div>
            @if (evaluation.withoutValidBatch) {
              <div style="margin-top: 8px; color: #c62828">
                <mat-icon style="vertical-align: -4px">block</mat-icon>
                @if (evaluation.latestBatch) {
                  {{ invalidHint(evaluation.latestBatch) }}；此前没有其他有效批次可沿用。
                } @else {
                  尚无覆盖全部应有测点（{{ expectedText(evaluation) }}）的复核批次，平均值 / 偏差 / 到位判断暂不可用。
                }
              </div>
            } @else {
              <div class="gb-table-wrap" style="margin-top: 8px">
                <table class="gb-table">
                  <thead>
                    <tr>
                      <th>批次时间</th>
                      <th>测点</th>
                      <th>平均位移</th>
                      <th>同步偏差</th>
                      <th>超限 / 关注 / 正常</th>
                      <th>超限项</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td class="gb-mono">{{ evaluation.activeBatch!.recordedAt }}</td>
                      <td>{{ evaluation.activeBatch!.expectedPointCodes.join('、') }}</td>
                      <td>{{ formatMm(evaluation.averageMm ?? 0) }}</td>
                      <td [style.color]="syncColor()">{{ formatMm(evaluation.syncDeviationMm ?? 0) }}</td>
                      <td>
                        <span style="color: #c62828">{{ evaluation.exceedCount }}</span> /
                        <span style="color: #ed6c02">{{ evaluation.watchCount }}</span> /
                        <span style="color: #2e7d32">{{ evaluation.okCount }}</span>
                      </td>
                      <td>
                        @if (evaluation.activeBatch!.breaches.length === 0) {
                          <span style="color: #2e7d32">无</span>
                        } @else {
                          @for (breach of evaluation.activeBatch!.breaches; track breach.pointCode) {
                            <div [style.color]="'#c62828'">
                              {{ breach.pointCode }}：{{ breachLabel(breach.displacementLimit, breach.stressAlert) }}
                            </div>
                          }
                        }
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            }
            @if (evaluation.stale && evaluation.latestBatch; as latest) {
              <div style="margin-top: 8px; color: #ed6c02">
                <mat-icon style="vertical-align: -4px">warning</mat-icon>
                {{ invalidHint(latest) }}；上表仍沿用上一批有效结果（{{ evaluation.activeBatch!.recordedAt }}）。
              </div>
            }
            <div class="gb-hint" style="margin-top: 8px">
              本步骤共 {{ evaluation.batches.length }} 批复核（有效 {{ evaluation.validBatchCount }} 批），原始读数全部保留；
              统计与到位判断只采用整批快照，不按各测点最新值拼凑。
            </div>
          </div>
        </mat-card>
      </div>
    }

    <div class="gb-section">
      <div class="gb-card-title" style="margin-bottom: 8px">已录入读数（{{ filtered().length }} 条，原始记录全部保留）</div>
      @if (filtered().length === 0) {
        <app-empty-panel
          title="暂无测点读数"
          description="选择步骤后批量录入，或在步骤页推进状态后再录入。"
          icon="sensors"
        />
      } @else {
        <div class="gb-table-wrap">
          <table class="gb-table">
            <thead>
              <tr>
                <th>步骤</th>
                <th>桥梁</th>
                <th>测点</th>
                <th>位移</th>
                <th>相对批次均值偏差</th>
                <th>应力</th>
                <th>批次</th>
                <th>记录时间</th>
                <th>记录人</th>
                <th>判定</th>
                <th style="width: 90px">操作</th>
              </tr>
            </thead>
            <tbody>
              @for (reading of filtered(); track reading.id) {
                <tr [class.row-inactive]="!reading.inActiveBatch">
                  <td>#{{ reading.stepSeq }}</td>
                  <td>{{ reading.bridgeName }}</td>
                  <td class="gb-mono">{{ reading.pointCode }}</td>
                  <td>{{ formatMm(reading.displacementMm) }}</td>
                  <td [style.color]="deviationCellColor(reading)">
                    @if (reading.deviationMm === null) {
                      <span class="gb-hint">—</span>
                    } @else {
                      {{ formatMm(reading.deviationMm) }}
                    }
                  </td>
                  <td [style.color]="reading.inActiveBatch && reading.stressAlert ? '#c62828' : reading.inActiveBatch ? '#2e7d32' : 'rgba(22,34,46,0.55)'">
                    {{ formatStress(reading.stressMpa) }}
                  </td>
                  <td>
                    <mat-chip-set>
                      @if (reading.inActiveBatch) {
                        <mat-chip style="background: #1b5e20; color: #fff">有效批 · 当前</mat-chip>
                      } @else if (reading.batchValid) {
                        <mat-chip style="background: #eceff1; color: #37474f">有效批 · 历史</mat-chip>
                      } @else {
                        <mat-chip style="background: #ffebee; color: #b71c1c" [matTooltip]="reading.batchInvalidNote">
                          缺测无效
                        </mat-chip>
                      }
                    </mat-chip-set>
                  </td>
                  <td>{{ reading.recordedAt }}</td>
                  <td>{{ reading.operator }}</td>
                  <td>
                    <mat-chip-set>
                      <mat-chip [style.background]="readingColor(reading)" [style.color]="'#fff'">
                        {{ readingLevelText(reading) }}
                      </mat-chip>
                    </mat-chip-set>
                  </td>
                  <td>
                    <button mat-button color="warn" (click)="deleteReading(reading)">
                      <mat-icon>delete</mat-icon>
                    </button>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
    </div>
  `,
  styles: [
    `
      .gb-input {
        width: 100%;
        padding: 6px 8px;
        border: 1px solid rgba(22, 34, 46, 0.2);
        border-radius: 6px;
        font-size: 13px;
      }
      tr.row-inactive {
        color: rgba(22, 34, 46, 0.6);
      }
    `,
  ],
})
export class ReadingEntryPage {
  private readonly store = inject(Store);
  private readonly idb = inject(IdbTableService);
  private readonly snackBar = inject(MatSnackBar);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  readonly ROUTES = ROUTES;
  readonly syncRequirementLabel = SYNC_REQUIREMENT_LABEL;
  readonly stepStateLabel = STEP_STATE_LABEL;
  readonly stressAlert = STRESS_ALERT_MPA;
  readonly formatMm = formatMm;
  readonly formatStress = formatStress;
  readonly syncAlertText = syncAlertText;
  readonly limitAlertText = limitAlertText;
  readonly invalidHint = invalidBatchHint;

  private readonly bridges: Signal<BridgeRow[]> = toSignal(this.store.select(selectBridges), {
    initialValue: [] as BridgeRow[],
  });
  private readonly steps: Signal<StepRow[]> = toSignal(this.store.select((state) => state.step.steps), {
    initialValue: [] as StepRow[],
  });
  private readonly readings: Signal<ReadingRow[]> = toSignal(
    this.store.select((state) => state.step.readings),
    { initialValue: [] as ReadingRow[] },
  );

  readonly stats = toSignal(this.store.select(selectStepStats), {
    initialValue: {
      total: 0,
      cumulativeMm: 0,
      arrived: 0,
      lifting: 0,
      idle: 0,
      readingCount: 0,
      maxLimitMm: 0,
    },
  });

  readonly stepViews: Signal<StepView[]> = computed(() =>
    buildStepViews(this.steps(), this.readings(), this.bridges()),
  );

  readonly keyword = signal('');
  readonly filters = signal<Record<string, string[]>>({ step: [], level: [] });
  readonly selectedStepId = signal('');
  readonly batchRows = signal<BatchRow[]>([]);
  /** 记录人（signal，模板双向绑定到 signal.set） */
  readonly operator = signal('陈立强');
  /** 记录时间（datetime-local 口径 yyyy-MM-ddTHH:mm） */
  readonly recordedAt = signal(nowDateTime().replace(' ', 'T'));

  readonly selects = computed<FilterSelectSpec[]>(() => [
    {
      key: 'step',
      label: '顶升步骤',
      options: this.stepViews().map((step) => `#${step.seq} ${step.bridgeName}`),
    },
    { key: 'level', label: '判定', options: ['正常', '关注', '超限', '不计入'] },
  ]);

  readonly selectedStep = computed(() =>
    this.stepViews().find((step) => step.id === this.selectedStepId()) ?? null,
  );

  /** 选中步骤的批次评估（整批快照口径） */
  readonly selectedEvaluation = computed<StepBatchEvaluation | null>(() => {
    const step = this.selectedStep();
    if (!step) return null;
    return evaluateStepBatches(step.id, this.readings(), step.syncRequirement, step.limitMm);
  });

  /** 读数视图：带步骤上下文、所属批次与相对当前批次均值的偏差；原始记录全部保留 */
  readonly readingViews: Signal<ReadingView[]> = computed(() => {
    const evaluations = new Map(
      this.stepViews().map((step) => [
        step.id,
        evaluateStepBatches(step.id, this.readings(), step.syncRequirement, step.limitMm),
      ]),
    );
    const steps = new Map(this.stepViews().map((step) => [step.id, step]));
    return this.readings()
      .map((reading) => {
        const step = steps.get(reading.stepId);
        const evaluation = evaluations.get(reading.stepId);
        const batch = evaluation?.batches.find((item) => item.recordedAt === reading.recordedAt) ?? null;
        const activeAt = evaluation?.activeBatch?.recordedAt ?? null;
        const latestAt = evaluation?.latestBatch?.recordedAt ?? null;
        const inActive = batch?.valid === true && batch.recordedAt === activeAt;
        return {
          ...reading,
          stepSeq: step?.seq ?? 0,
          bridgeId: step?.bridgeId ?? '',
          bridgeName: step?.bridgeName ?? '未归属桥梁',
          syncRequirement: step ? SYNC_REQUIREMENT_LABEL[step.syncRequirement] : '-',
          // 偏差仅对有效整批给出；缺测批次不拼凑均值
          deviationMm:
            batch && batch.valid && batch.averageMm !== null
              ? Number((reading.displacementMm - batch.averageMm).toFixed(3))
              : null,
          batchValid: batch?.valid ?? false,
          inActiveBatch: inActive,
          inLatestBatch: batch?.recordedAt === latestAt,
          batchInvalidNote: batch && !batch.valid ? invalidBatchHint(batch) : '',
          overLimit: inActive && (step?.limitMm ?? 0) > 0 && Math.abs(reading.displacementMm) >= (step?.limitMm ?? 0),
          stressAlert: inActive && reading.stressMpa >= STRESS_ALERT_MPA,
        };
      })
      .sort((a, b) =>
        a.stepSeq === b.stepSeq
          ? b.recordedAt.localeCompare(a.recordedAt) || a.pointCode.localeCompare(b.pointCode)
          : a.stepSeq - b.stepSeq,
      );
  });

  readonly filtered = computed(() => {
    const lower = this.keyword().trim().toLowerCase();
    const stepLabels = this.filters()['step'] ?? [];
    const levelLabels = this.filters()['level'] ?? [];
    return this.readingViews().filter((reading) => {
      if (stepLabels.length > 0 && !stepLabels.includes(`#${reading.stepSeq} ${reading.bridgeName}`)) return false;
      if (levelLabels.length > 0 && !levelLabels.includes(this.readingLevelText(reading))) return false;
      if (lower && !`${reading.pointCode} ${reading.operator}`.toLowerCase().includes(lower)) return false;
      return true;
    });
  });

  /** 当前有效批次平均位移；无有效批次返回 null（徽标显示 —） */
  readonly currentAverage = computed<number | null>(() => this.selectedEvaluation()?.averageMm ?? null);
  /** 当前有效批次同步偏差；无有效批次返回 null */
  readonly currentDeviation = computed<number | null>(() => this.selectedEvaluation()?.syncDeviationMm ?? null);
  readonly activeExceedCount = computed(() => this.selectedEvaluation()?.exceedCount ?? 0);

  readonly batchAverage = computed(() => meanDisplacement(this.batchRows()));
  readonly batchDeviation = computed(() => syncDeviationMm(this.batchRows()));
  readonly batchMax = computed(() =>
    this.batchRows().length === 0 ? 0 : Math.max(...this.batchRows().map((item) => Math.abs(item.displacementMm))),
  );

  /** 同一步骤在当前选择时间已有批次时提示 */
  readonly existingBatchAt = computed<string | null>(() => {
    const step = this.selectedStep();
    const recorded = this.recordedAt().replace('T', ' ');
    if (!step || !recorded) return null;
    const exists = this.readings().some(
      (item) => item.stepId === step.id && item.recordedAt === recorded,
    );
    return exists ? recorded : null;
  });

  constructor() {
    this.route.queryParamMap.subscribe((params) => {
      this.keyword.set(params.get('kw') ?? '');
      const next: Record<string, string[]> = { step: [], level: [] };
      for (const key of Object.keys(next)) {
        const raw = params.get(key);
        next[key] = raw ? raw.split(',').map((item) => item.trim()).filter(Boolean) : [];
      }
      this.filters.set(next);
      const stepId = params.get('stepId');
      if (stepId) this.onStepChange(stepId);
    });

    // 默认选中第一个步骤并生成测点行
    queueMicrotask(() => {
      if (!this.selectedStepId() && this.stepViews().length > 0) {
        this.onStepChange(this.stepViews()[0].id);
      }
    });
  }

  currentAverageText(): string {
    const value = this.currentAverage();
    return value === null ? '—' : formatMm(value);
  }

  currentDeviationText(): string {
    const value = this.currentDeviation();
    return value === null ? '—' : formatMm(value);
  }

  activeBatchHint(): string {
    const evaluation = this.selectedEvaluation();
    if (!evaluation) return '未选择步骤';
    if (evaluation.withoutValidBatch) return '尚无有效复核批次（缺测批次不参与统计）';
    const base = `依据批次 ${evaluation.activeBatch?.recordedAt ?? ''}`;
    return evaluation.stale && evaluation.latestBatch
      ? `${base}；最新批 ${evaluation.latestBatch.recordedAt} 缺测无效，沿用该批`
      : base;
  }

  expectedText(evaluation: StepBatchEvaluation): string {
    return evaluation.latestBatch?.expectedPointCodes.join('、') ?? 'P1、P2、P3、P4';
  }

  breachLabel(displacementLimit: boolean, stressAlert: boolean): string {
    const labels: string[] = [];
    if (displacementLimit) labels.push('位移达到限位');
    if (stressAlert) labels.push(`应力达到关注值 ${STRESS_ALERT_MPA} MPa`);
    return labels.join('，');
  }

  selectedStepLabel(): string {
    const step = this.selectedStep();
    if (!step) return '未选择步骤';
    return `#${step.seq} ${step.bridgeName} · 目标 ${step.targetLiftMm} mm · 限位 ${step.limitMm} mm`;
  }

  dateHint(): string {
    const step = this.selectedStep();
    return readingDateHint(this.recordedAt().replace('T', ' '), step?.state ?? 'idle');
  }

  onStepChange(stepId: string): void {
    this.selectedStepId.set(stepId);
    this.regenerateRows();
    const queryParams: Record<string, string> = { stepId };
    if (this.keyword().trim()) queryParams['kw'] = this.keyword().trim();
    for (const [key, list] of Object.entries(this.filters())) {
      if (list.length > 0) queryParams[key] = list.join(',');
    }
    void this.router.navigate([], { relativeTo: this.route, queryParams, replaceUrl: true });
  }

  /** 按同步要求生成测点行（同步 4 点、交叉 4 点、单点 1 点） */
  regenerateRows(): void {
    const step = this.selectedStep();
    if (!step) {
      this.batchRows.set([]);
      return;
    }
    const codes = step.syncRequirement === 'single' ? ['P1'] : suggestPointCodes(2).slice(0, 4);
    this.batchRows.set(
      codes.map((pointCode) => ({ pointCode, displacementMm: step.targetLiftMm, stressMpa: 8 })),
    );
  }

  /** 按目标顶升量填参考值（略带测点间差异，便于观察同步偏差） */
  fillReference(): void {
    const step = this.selectedStep();
    if (!step) return;
    this.batchRows.set(
      this.batchRows().map((row, index) => ({
        ...row,
        displacementMm: Number((step.targetLiftMm - index * 0.2).toFixed(2)),
        stressMpa: Number((8 + index * 0.4).toFixed(2)),
      })),
    );
  }

  updateRow(pointCode: string, field: 'displacementMm' | 'stressMpa', value: number): void {
    this.batchRows.set(
      this.batchRows().map((row) => (row.pointCode === pointCode ? { ...row, [field]: Number(value) } : row)),
    );
  }

  rowLevelText(row: BatchRow): string {
    const step = this.selectedStep();
    if (!step) return '—';
    const level = overallLevel(row.displacementMm, step.limitMm, row.stressMpa);
    return TOLERANCE_LEVEL_LABEL[level];
  }

  rowColor(row: BatchRow): string {
    const step = this.selectedStep();
    if (!step) return TOLERANCE_HEX.ok;
    return TOLERANCE_HEX[overallLevel(row.displacementMm, step.limitMm, row.stressMpa)];
  }

  batchDeviationLevel(): ToleranceLevel {
    return syncLevel(this.batchDeviation());
  }

  syncColor(): string {
    const deviation = this.currentDeviation();
    if (deviation === null) return 'rgba(22,34,46,0.45)';
    return TOLERANCE_HEX[syncLevel(deviation)];
  }

  syncLevelText(): string {
    const deviation = this.currentDeviation();
    if (deviation === null) return '无有效批次';
    return TOLERANCE_LEVEL_LABEL[syncLevel(deviation)];
  }

  deviationShare(): number {
    const deviation = this.currentDeviation();
    if (deviation === null) return 0;
    return Math.min(100, Number(((deviation / 1.5) * 100).toFixed(1)));
  }

  deviationCellColor(reading: ReadingView): string {
    if (!reading.inActiveBatch || reading.deviationMm === null) return 'rgba(22,34,46,0.55)';
    return reading.deviationMm === 0 ? '#2e7d32' : '#ed6c02';
  }

  /** 判定：非当前有效批次的原始记录标注「不计入」，避免旧数据掩盖纠正后的异常 */
  readingLevelText(reading: ReadingView): string {
    if (!reading.inActiveBatch) return '不计入';
    const step = this.stepViews().find((item) => item.id === reading.stepId);
    const limitMm = step?.limitMm ?? 0;
    return TOLERANCE_LEVEL_LABEL[overallLevel(reading.displacementMm, limitMm, reading.stressMpa)];
  }

  readingColor(reading: ReadingView): string {
    if (!reading.inActiveBatch) return '#90a4ae';
    const limitMm = this.stepViews().find((item) => item.id === reading.stepId)?.limitMm ?? 0;
    return TOLERANCE_HEX[overallLevel(reading.displacementMm, limitMm, reading.stressMpa)];
  }

  async submitBatch(): Promise<void> {
    const step = this.selectedStep();
    const rows = this.batchRows();
    if (!step || rows.length === 0) return;
    const recorded = this.recordedAt().replace('T', ' ');
    const payload = rows.map((row) => ({
      stepId: step.id,
      pointCode: row.pointCode,
      displacementMm: row.displacementMm,
      stressMpa: row.stressMpa,
      recordedAt: recorded,
      operator: this.operator(),
    }));
    await putReadings(
      payload.map((row) => ({ ...row, id: newId('read'), ...rowMeta() })),
    );
    this.idb.emitChange();

    // 提交后立刻按整批快照口径提示本批是否有效
    const all = [...this.readings(), ...payload.map((row) => ({ ...row, id: 'pending' } as ReadingRow))];
    const batch = evaluateStepBatches(step.id, all, step.syncRequirement, step.limitMm).latestBatch;
    if (batch && !batch.valid) {
      this.snackBar.open(
        `${invalidBatchHint(batch)}。${payload.length} 条原始读数已保存`,
        '知道了',
        { duration: 4200 },
      );
    } else {
      this.snackBar.open(
        `已录入 ${payload.length} 条读数（批次 ${recorded}），同步偏差 ${formatMm(syncDeviationMm(rows))}`,
        '关闭',
        { duration: 3000 },
      );
    }
  }

  async deleteReading(reading: ReadingView): Promise<void> {
    if (!confirm(`确认删除测点 ${reading.pointCode} 在 ${reading.recordedAt} 的读数？该批次其余原始记录保留。`)) return;
    await this.idb.database.readings.delete(reading.id);
    this.idb.emitChange();
    this.snackBar.open('测点读数已删除；若该批次因此缺测将判为无效', '关闭', { duration: 3000 });
  }

  go(path: string): void {
    void this.router.navigate([path]);
  }

  onKeyword(value: string): void {
    this.keyword.set(value);
    this.syncQuery(value, this.filters());
  }

  onFilters(values: Record<string, string[]>): void {
    this.filters.set(values);
    this.syncQuery(this.keyword(), values);
  }

  clearFilters(): void {
    this.keyword.set('');
    this.filters.set({ step: [], level: [] });
    this.syncQuery('', { step: [], level: [] });
  }

  private syncQuery(keyword: string, values: Record<string, string[]>): void {
    const queryParams: Record<string, string> = {};
    if (keyword.trim()) queryParams['kw'] = keyword.trim();
    if (this.selectedStepId()) queryParams['stepId'] = this.selectedStepId();
    for (const [key, list] of Object.entries(values)) {
      if (list.length > 0) queryParams[key] = list.join(',');
    }
    void this.router.navigate([], { relativeTo: this.route, queryParams, replaceUrl: true });
  }
}

import type { ArchiveRow, EntryRow, ModuleMeta } from './types'

// 领域口径统一在这里裁决：列表、过滤、另存、概览都只能读 normalize 之后的记录，不再各自累加。

/** 各模块明确属于异常态的状态：异常量按记录状态重算，不沿用历史标记。 */
const ABNORMAL_STATUSES: Record<string, string[]> = {
  tunnel: ['检修中'],
  pipeline: [],
  envmonitor: ['指标超标'],
  ventilation: ['故障停机'],
  drainage: ['水泵故障'],
  firecontrol: ['需维修'],
  lighting: ['已损坏'],
  access: ['需整改'],
  patrol: ['已上报'],
  settlement: ['超限预警'],
  leak: ['需返工'],
  maintenance: ['已延期'],
  hazard: ['已逾期'],
  emergency: ['已取消'],
  energy: ['数据异常'],
  device: [],
  entryapprove: ['已驳回'],
  duty: ['有遗留'],
}

/** “本月”类指标对应的完工/发生日期字段。 */
const MONTH_DATE_FIELD: Record<string, string> = {
  patrol: '完成时间',
  leak: '完工日期',
  maintenance: '完工日期',
  emergency: '计划日期',
}

/**
 * 各模块“待办（pending）”口径：只有真正还挂着没处理完的状态才进待办清单。
 * 未列出的模块沿用默认（非末态即待办）。
 */
const PENDING_STATUSES: Record<string, string[]> = {
  tunnel: ['待投运'],
  pipeline: ['待登记'],
  envmonitor: ['待采集', '已采集'],
  ventilation: ['待开机'],
  drainage: ['待排水', '排水中'],
  firecontrol: ['待检测', '检测中'],
  lighting: ['待巡检', '巡检中'],
  access: ['待检查', '检查中'],
  patrol: ['待巡检', '巡检中'],
  settlement: ['待监测', '监测中'],
  leak: ['待处置', '处置中'],
  maintenance: ['待开工', '检修中'],
  hazard: ['待整改', '整改中', '已逾期'],
  emergency: ['待组织', '演练中'],
  energy: ['待抄表'],
  device: ['待保养'],
  entryapprove: ['待审批'],
  duty: ['待交接', '交接中', '有遗留'],
}

function isPending(meta: ModuleMeta, status: string): boolean {
  const set = PENDING_STATUSES[meta.key]
  return set ? set.includes(status) : status !== meta.statuses[meta.statuses.length - 1]
}

function statusField(meta: ModuleMeta): string | null {
  return meta.fields.find((field) => field.endsWith('状态')) ?? null
}

/** 入廊管线是否在役：只认状态，已迁出（或待登记）一律不算在用，按记录取值而不是累加。 */
export function isPipelineInService(row: EntryRow): boolean {
  return row.status === '已入廊' || row.status === '运行中'
}

function isAbnormal(meta: ModuleMeta, status: string): boolean {
  return (ABNORMAL_STATUSES[meta.key] ?? []).includes(status)
}

function validDate(value: unknown): boolean {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)
}

/**
 * 存量管线按入廊日期回填：有入廊日期却仍是“待登记”的早年记录，拨正为“已入廊”；
 * 早年标记与实际情况不符的，以能核实的登记事实（入廊日期、归档件）为准。
 * 缺项（设计容量、联系人等）保持空值，由登记侧的“备注”注明缘由，不替历史造数。
 */
function reconcilePipelineStatus(row: EntryRow, archives: ArchiveRow[]): string {
  // 只有“迁出归档”是管线生命周期结论，可据以拨正运行台账；
  // “登记归档”冻结的是登记时刻的旧状态，仅作留档，不得用它覆盖按入廊日期的回填。
  const archived = archives
    .filter((item) => item.kind === '迁出归档' && item.refId === row.id && item.snapshot)
    .sort((a, b) => (a.archivedAt < b.archivedAt ? 1 : -1))[0]
  if (archived) {
    return String(archived.snapshot.status ?? row.status)
  }
  if (row.status === '待登记' && validDate(row['入廊日期'])) {
    return '已入廊'
  }
  return String(row.status)
}

/**
 * 把一条原始记录拨正为对外呈现的结论：状态字段与行内业务状态列同步，
 * pending/abnormal 与在役标记全部按 status 重算。
 * 启动/迁移做存量拨正时由归档件裁决历史争议；动作写入时 explicitStatus 是本笔的明确结论，
 * 优先级最高，归档件不得把它改回旧值。
 */
export function normalizeRow(
  meta: ModuleMeta,
  row: EntryRow,
  archives: ArchiveRow[] = [],
  explicitStatus?: string,
): EntryRow {
  let status = explicitStatus ?? String(row.status ?? meta.statuses[0])
  if (!meta.statuses.includes(status)) {
    status = meta.statuses[0]
  }
  if (meta.key === 'pipeline' && explicitStatus === undefined) {
    status = reconcilePipelineStatus(row, archives)
  }

  const field = statusField(meta)
  const next: EntryRow = {
    ...row,
    status,
    pending: isPending(meta, status),
    abnormal: isAbnormal(meta, status),
  }
  if (field) {
    next[field] = status
  }
  if (meta.key === 'pipeline') {
    next['在役'] = isPipelineInService(next)
  }
  return next
}

export function normalizeAll(
  metas: ModuleMeta[],
  tables: Record<string, EntryRow[]>,
  archives: ArchiveRow[],
): Record<string, EntryRow[]> {
  const next: Record<string, EntryRow[]> = {}
  for (const meta of metas) {
    next[meta.key] = (tables[meta.key] ?? []).map((row) => normalizeRow(meta, row, archives))
  }
  return next
}

function currentMonth(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

/**
 * 指标卡按当前台账记录重算。
 * metricStatuses 给出该指标覆盖的状态；null 表示“本月”类指标，按对应日期字段取当月。
 */
export function computeMetric(
  meta: ModuleMeta,
  rows: EntryRow[],
  index: number,
): number {
  const mapped = meta.metricStatuses?.[index]
  if (mapped) {
    return rows.filter((row) => mapped.includes(String(row.status))).length
  }
  const dateField = MONTH_DATE_FIELD[meta.key]
  const month = currentMonth()
  const terminal = meta.statuses[meta.statuses.length - 1]
  return rows.filter((row) => {
    const value = dateField ? row[dateField] : ''
    return typeof value === 'string' && value.startsWith(month) && row.status === terminal
  }).length
}

export function nextId(rows: { id: number }[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function nowStamp(): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * 管线迁出对其他入口的联动（保养/检修台账对齐、值班台账同步）。
 * 幂等：同一管线重复调用只产生一次结论，保养台账不重复登记。
 * 入参 tables 必须已 normalize；返回需要落库的改动表（就地修改后返回）。
 */
export function applyRetirementSideEffects(
  tables: Record<string, EntryRow[]>,
  archives: ArchiveRow[],
  pipeline: EntryRow,
  stamp: string = nowStamp(),
): { tables: Record<string, EntryRow[]>; archives: ArchiveRow[] } {
  const code = String(pipeline['管线编号'])
  const maintenance = [...(tables['maintenance'] ?? [])]
  const duty = [...(tables['duty'] ?? [])]
  const nextArchives = [...archives]

  // 保养（检修）台账：关闭该管线尚未办结的检修单；没有任何结论单则补一条“已完工”结论，两边登记对齐。
  let touched = false
  for (const row of maintenance) {
    const about = String(row['检修对象'] ?? '')
    if (about.includes(code) && row.status !== '已完工') {
      row.status = '已完工'
      row.pending = false
      row.abnormal = false
      row['检修状态'] = '已完工'
      if (!validDate(row['完工日期'])) {
        row['完工日期'] = stamp.slice(0, 10)
      }
      const tail = `（管线${code}迁出，随迁出办结）`
      row['更换部件'] = `${String(row['更换部件'] ?? '')}${tail}`
      touched = true
    }
  }
  const hasConclusion = maintenance.some(
    (row) => String(row['检修对象'] ?? '').includes(code) && String(row['更换部件'] ?? '').includes('随迁出办结'),
  )
  if (!hasConclusion) {
    maintenance.push({
      id: nextId(maintenance),
      status: '已完工',
      pending: false,
      abnormal: false,
      '检修编号': `MAIN-PIPE-${String(pipeline.id).padStart(4, '0')}`,
      '检修对象': `${code} 入廊管线（迁出收尾）`,
      '检修类别': '迁出保养',
      '检修班组': '运维一班',
      '计划工期': stamp.slice(0, 10),
      '完工日期': stamp.slice(0, 10),
      '更换部件': `管线${code}办理迁出，随迁出办结（保养台账对齐结论，只登记一次）`,
      '检修状态': '已完工',
    })
    touched = true
  }

  // 值班台账：同步一条交接记录，注明迁出事项；同一管线同一天不重复落。
  const day = stamp.slice(0, 10)
  const dutyExists = duty.some(
    (row) => String(row['交接事项'] ?? '').includes(code) && String(row['值班日期'] ?? '') === day,
  )
  if (!dutyExists) {
    duty.push({
      id: nextId(duty),
      status: '已交接',
      pending: false,
      abnormal: false,
      '交接编号': `DUTY-PIPE-${String(pipeline.id).padStart(4, '0')}`,
      '值班班组': '运维一班',
      '值班日期': day,
      '班次': '白班',
      '值班人员': '值班管理员',
      '交接事项': `入廊管线${code}办理迁出，保养台账已对齐，待办清单同步核销`,
      '交接人员': '值班管理员',
      '交接状态': '已交接',
    })
  }

  if (touched) {
    tables['maintenance'] = maintenance
  }
  tables['duty'] = duty

  // 归档件：冻结迁出快照留档备查；已存在同一管线的迁出归档则不重复落（重复迁出只落一次）。
  const archived = nextArchives.some((item) => item.kind === '迁出归档' && item.refId === pipeline.id)
  if (!archived) {
    nextArchives.push({
      id: nextId(nextArchives),
      kind: '迁出归档',
      refId: pipeline.id,
      refCode: code,
      archivedAt: stamp,
      note: `管线${code}办理迁出，迁出前结论冻结归档；对外以运行台账为准，本件留档备查`,
      snapshot: { ...pipeline },
    })
  }

  return { tables, archives: nextArchives }
}

/** 首次落库时为存量管线生成“登记归档”：按登记时刻（入廊日期）落库，缺项留空。 */
export function buildRegistrationArchives(rows: EntryRow[]): ArchiveRow[] {
  return rows
    .filter((row) => validDate(row['入廊日期']))
    .map((row, index) => ({
      id: index + 1,
      kind: '登记归档',
      refId: row.id,
      refCode: String(row['管线编号']),
      archivedAt: String(row['入廊日期']),
      note: '存量管线按入廊日期（登记时刻）落库留档；早期条目缺项留空并在备注注明缘由',
      snapshot: { ...row },
    }))
}

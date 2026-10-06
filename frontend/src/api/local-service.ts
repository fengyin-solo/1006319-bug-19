import {
  appendEvent,
  commitRows,
  listRows,
  nextRowId,
  normalizeRow,
  resetRows,
} from '@/data/local-store'
import { MODULE_BY_KEY } from '@/data/modules'
import type {
  ActionContext,
  ActionResult,
  EntryRow,
  ListOptions,
  ModuleMeta,
  OverviewResult,
  PageResult,
} from '@/data/types'

const DEFAULT_OPERATOR = '值班管理员'

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

/** 在用/健康口径：默认取模块 healthyStatuses，pipeline 即 已入廊∪运行中（不含已迁出）。 */
export function isActiveRow(meta: ModuleMeta, row: EntryRow): boolean {
  return meta.healthyStatuses.includes(String(row.status))
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

function pickRows(meta: ModuleMeta, options: ListOptions = {}): EntryRow[] {
  let rows = listRows(meta.key)
  if (options.activeOnly) {
    rows = rows.filter((row) => isActiveRow(meta, row))
  }
  return filterRows(rows, options.filters ?? {})
}

/** 列表、过滤结果、另存清单共用这一个入口，读到的是同一份口径。 */
export function listEntries(key: string, options: ListOptions = {}): PageResult {
  const meta = moduleMeta(key)
  const matched = pickRows(meta, options)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

function sameMonth(value: string, ref: Date): boolean {
  if (!value) {
    return false
  }
  const date = new Date(value)
  return (
    !Number.isNaN(date.getTime()) &&
    date.getFullYear() === ref.getFullYear() &&
    date.getMonth() === ref.getMonth()
  )
}

/**
 * 按当前记录重算指标卡片，绝不累加：
 * 普通指标按标签里出现的状态名计数；「本月…」按口径状态 + 业务日期落在当月计数。
 */
export function moduleStats(key: string): { label: string; value: number }[] {
  const meta = moduleMeta(key)
  const rows = listRows(meta.key)
  const now = new Date()
  return meta.metrics.map((label) => {
    if (label.startsWith('本月')) {
      const monthlyStatuses = meta.pendingStatusesMonthly
      const dateField = meta.dateField
      const value = rows.filter(
        (row) =>
          (monthlyStatuses ?? [String(row.status)]).includes(String(row.status)) &&
          dateField !== '' &&
          sameMonth(String(row[dateField] ?? ''), now),
      ).length
      return { label, value }
    }
    const status = meta.statuses
      .slice()
      .sort((a, b) => b.length - a.length)
      .find((item) => label.includes(item))
    return {
      label,
      value: status ? rows.filter((row) => String(row.status) === status).length : 0,
    }
  })
}

/**
 * 状态流转。管线迁出带跨台账侧写：
 * 管线状态 + 在用取值一并改写，保养台账（设施检修管理）与值班交接台账各落一条对齐记录。
 * 同一管线重复迁出：业务事件只落一次、侧写只写一次；
 * 同一时刻并发提交：按版本号裁决，后到的一笔（含两笔侧写）整笔回退。
 */
export function runAction(key: string, id: number, action: string, context: ActionContext = {}): ActionResult {
  return executeAction(key, id, action, context)
}

function executeAction(
  key: string,
  id: number,
  action: string,
  context: ActionContext,
  baseRev?: number,
): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }

  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = rows[index]
  const currentStatus = String(current.status)
  const operator = context.operator || DEFAULT_OPERATOR
  const at = new Date().toISOString()
  const idempotencyKey = `${key}:${id}:${action}`
  // 并发测试可注入旧基线；正常办理以库内当前版本为基线。
  const expectedRev = baseRev ?? current.rev

  // 已经是目标态：重复办理只认第一次的结果，不重复落事件、不重复侧写。
  if (currentStatus === target && baseRev === undefined) {
    return { ok: true, message: `${meta.entity}已是「${target}」，${action}只落一次，无需重复办理` }
  }

  const updated: EntryRow = normalizeRow({ ...current, status: target, rev: expectedRev + 1 }, key)
  const nextRows = rows.slice()
  nextRows[index] = updated

  // 管线迁出：结论同步落到保养台账与值班台账，两边登记对齐，待办随之核销。
  const sideWrites: { key: string; rows: EntryRow[]; expectedRev: Record<number, number> }[] = []
  if (key === 'pipeline' && action === '办理迁出') {
    const pipelineNo = String(current['管线编号'] ?? `PIPE-${id}`)
    const cabin = String(current['所属舱室'] ?? '')
    const pipeType = String(current['管线类型'] ?? '')

    // 保养台账：为这次迁出注销登记一条已完工保养记录（其它入口看到的结论与本页一致）。
    const maintenanceKey = 'maintenance'
    const maintenanceRows = listRows(maintenanceKey)
    const maintenanceId = nextRowId(maintenanceKey)
    const maintenanceRow = normalizeRow(
      {
        id: maintenanceId,
        status: '已完工',
        pending: false,
        abnormal: false,
        rev: 0,
        registeredAt: at,
        检修编号: `MAIN-MV-${String(id).padStart(4, '0')}`,
        检修对象: `入廊管线 ${pipelineNo}`,
        检修类别: '管线迁出注销保养',
        检修班组: context.crew || '运维综合班',
        计划工期: at.slice(0, 10),
        完工日期: at.slice(0, 10),
        更换部件: '—',
        remark: `依据管线 ${pipelineNo} 迁出归档结论自动登记，与入廊管线台账对齐；舱室：${cabin || '未填'}；类型：${pipeType || '未填'}`,
      },
      maintenanceKey,
    )
    sideWrites.push({ key: maintenanceKey, rows: [...maintenanceRows, maintenanceRow], expectedRev: {} })

    // 值班台账：迁出办结生成一条已交接记录，交接事项核销，不再占用待办。
    const dutyKey = 'duty'
    const dutyRows = listRows(dutyKey)
    const dutyId = nextRowId(dutyKey)
    const dutyRow = normalizeRow(
      {
        id: dutyId,
        status: '已交接',
        pending: false,
        abnormal: false,
        rev: 0,
        registeredAt: at,
        交接编号: `DUTY-MV-${String(id).padStart(4, '0')}`,
        值班班组: context.crew || '运维综合班',
        值班日期: at.slice(0, 10),
        班次: context.shift || '当班',
        值班人员: operator,
        交接事项: `管线 ${pipelineNo} 办理迁出并办结，在用台账已注销，保养台账已登记`,
        交接人员: operator,
        remark: `由管线 ${pipelineNo} 迁出动作同步生成，待办清单同步核销`,
      },
      dutyKey,
    )
    sideWrites.push({ key: dutyKey, rows: [...dutyRows, dutyRow], expectedRev: {} })
  }

  // 同一时刻两笔提交：主记录版本不符则整笔回退（侧写也一笔不写）。
  const committed = commitRows([
    { key, rows: nextRows, expectedRev: { [id]: expectedRev } },
    ...sideWrites,
  ])
  if (!committed) {
    return {
      ok: false,
      conflict: true,
      message: `同一记录已有先到的提交入账，本笔${action}整笔回退，请刷新后按最新记录办理`,
    }
  }

  appendEvent({ key, rowId: id, action, idempotencyKey, operator, at })
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」；在用口径、保养与值班台账已同步` }
}

/** 测试用：按指定基线版本提交动作，模拟「同一时刻、同一记录」的并发后到一笔（含侧写）。 */
export function runActionAtRev(
  key: string,
  id: number,
  action: string,
  baseRev: number,
  context: ActionContext = {},
): ActionResult {
  return executeAction(key, id, action, context, baseRev)
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string, options: ListOptions = {}): { filename: string; content: string } {
  const meta = moduleMeta(key)
  // 另存清单与页面、过滤结果读同一份口径，条数对得上。
  const rows = pickRows(meta, options)
  const header = ['编号', ...meta.fields, '当前状态', '登记时刻', '备注']
  const lines = [header.join(',')]
  for (const row of rows) {
    lines.push(
      [
        row.id,
        ...meta.fields.map((field) => csvCell(row[field])),
        row.status,
        row.registeredAt,
        csvCell(row.remark),
      ].join(','),
    )
  }
  const scope = options.activeOnly ? '在用' : '全部'
  return { filename: `${meta.name}-${scope}清单.csv`, content: `﻿${lines.join('\n')}` }
}

function csvCell(value: unknown): string {
  const text = String(value ?? '')
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function downloadEntries(key: string, options: ListOptions = {}): void {
  const { filename, content } = exportEntries(key, options)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = listRows(meta.key)
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
      healthy: entries.filter((row) => isActiveRow(meta, row)).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '在用/正常', value: modules.reduce((sum, item) => sum + item.healthy, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}

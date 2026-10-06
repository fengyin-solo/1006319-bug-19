import { MODULE_BY_KEY, MODULES } from '@/data/modules'
import {
  acquire,
  allRows,
  commitAll,
  hasCommitted,
  listArchives,
  listRows,
  release,
  resetRows,
  state,
} from '@/data/local-store'
import {
  applyRetirementSideEffects,
  computeMetric,
  isPipelineInService,
  normalizeRow,
} from '@/data/reconcile'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(
  rows: EntryRow[],
  filters: Record<string, string>,
  scope: 'all' | 'inUse' = 'all',
): EntryRow[] {
  // 在用清单只取在役记录：已迁出的管线按记录被排除，过滤结果不再残留旧记录。
  const scoped = scope === 'inUse' ? rows.filter(isPipelineInService) : rows
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return scoped
  }
  return scoped.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(
  key: string,
  filters: Record<string, string> = {},
  scope: 'all' | 'inUse' = 'all',
): PageResult {
  const matched = filterRows(listRows(key), filters, key === 'pipeline' ? scope : 'all')
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

/** 指标卡：全部按当前台账记录重算，迁移出一条就在口径里减一条，绝不累加历史值。 */
export function moduleStats(key: string): { label: string; value: number }[] {
  const meta = moduleMeta(key)
  const rows = listRows(key)
  return meta.metrics.map((label, index) => ({ label, value: computeMetric(meta, rows, index) }))
}

function stamp(): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function runAction(key: string, id: number, action: string): ActionResult {
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
  const current = String(rows[index].status)
  if (current === target) {
    // 同一条管线重复办理迁出：幂等成功，只落一次，不再产生联动单据。
    if (key === 'pipeline' && action === '办理迁出') {
      return { ok: true, message: `${meta.entity}已迁出，重复办理不再重复落账` }
    }
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }

  const token = `${key}:${id}:${action}:${stamp()}`
  if (hasCommitted(token) || !acquire(token)) {
    return { ok: false, message: '同一时刻已有先到的提交入账，本笔已整笔回退' }
  }

  try {
    const at = stamp()
    const updated: EntryRow = normalizeRow(
      meta,
      {
        ...rows[index],
        status: target,
        abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
      },
      listArchives(),
      target,
    )
    // 办理迁出：管线标记、在役口径、保养台账、值班台账、归档件在同一笔事务里改写。
    if (key === 'pipeline' && action === '办理迁出') {
      updated['迁出日期'] = at.slice(0, 10)
      const tables = { ...allRows(), pipeline: rows.map((row, i) => (i === index ? updated : row)) }
      const { tables: settled, archives } = applyRetirementSideEffects(
        tables,
        listArchives(),
        updated,
        at,
      )
      commitAll(
        { pipeline: settled.pipeline, maintenance: settled.maintenance, duty: settled.duty },
        archives,
        token,
      )
    } else {
      commitAll({ [key]: rows.map((row, i) => (i === index ? updated : row)) }, listArchives(), token)
    }
    return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
  } catch (error) {
    // 整笔回退：不调用 commit，缓存未落库；释放占位后返回失败。
    return {
      ok: false,
      message: error instanceof Error ? error.message : `${meta.entity}${action}失败，已整笔回退`,
    }
  } finally {
    release(token)
  }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

/** 另存清单与页面读同一份：按当前过滤条件（含在用口径）导出，条数与页脚一致。 */
export function exportEntries(
  key: string,
  filters: Record<string, string> = {},
  scope: 'all' | 'inUse' = 'all',
): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const rows = listEntries(key, filters, key === 'pipeline' ? scope : 'all').items
  const header = ['编号', ...meta.fields, '在役', '当前状态']
  const lines = [header.join(',')]
  for (const row of rows) {
    const inService = key === 'pipeline' ? (isPipelineInService(row) ? '在用' : '非在用') : ''
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), inService, row.status].join(','))
  }
  const suffix = key === 'pipeline' && scope === 'inUse' ? '-在用清单' : '-清单'
  return { filename: `${meta.name}${suffix}.csv`, content: `﻿${lines.join('\n')}` }
}

export function downloadEntries(
  key: string,
  filters: Record<string, string> = {},
  scope: 'all' | 'inUse' = 'all',
): void {
  const { filename, content } = exportEntries(key, filters, scope)
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
  const store = state()
  const modules = MODULES.map((meta) => {
    const entries = store.tables[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}

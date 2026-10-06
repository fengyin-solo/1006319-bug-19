import { MODULE_BY_KEY } from './modules'
import { SEED_ROWS } from './seed'
import type { EntryRow, EventRecord } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
// entries 只存「按归档结论重算后」的唯一真相版本；ledger 是只追加的事件台账与旧值归档。
const STORAGE_KEY = 'urban-utility-tunnel:entries'
const LEDGER_KEY = 'urban-utility-tunnel:ledger'
const SCHEMA_VERSION = 2
const ARCHIVE_REASON_LEGACY = '存量记录按入廊/业务日期回填登记时刻，缺项留空；状态标记以归档件为准统一重算'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

type Ledger = {
  events: EventRecord[]
  nextEventSeq: number
  /** 迁移前的旧记录整份留档，对外不呈现，只备查。 */
  archive: { key: string; reason: string; at: string; rows: unknown[] }[]
}

function emptyLedger(): Ledger {
  return { events: [], nextEventSeq: 1, archive: [] }
}

function nowIso(): string {
  return new Date().toISOString()
}

function validDate(value: unknown): string {
  if (typeof value !== 'string') {
    return ''
  }
  const text = value.trim()
  // 只接受能被 Date 解析、且形如日期的业务字段（YYYY-MM-DD 或带时间）。
  if (!/^\d{4}-\d{2}-\d{2}/.test(text)) {
    return ''
  }
  const parsed = new Date(text)
  return Number.isNaN(parsed.getTime()) ? '' : text
}

/**
 * 以归档状态为准把一条记录拨正：
 * status 是唯一真相，pending/abnormal/末位业务字段都由它派生；登记时刻按业务日期回填。
 */
function canonicalize(row: EntryRow, key: string, archived: boolean): EntryRow {
  const meta = MODULE_BY_KEY.get(key)
  const status = String(row.status ?? '')
  const remarks: string[] = []
  if (archived && typeof row.remark === 'string' && row.remark.trim()) {
    remarks.push(row.remark.trim())
  }

  let registeredAt = typeof row.registeredAt === 'string' ? row.registeredAt : ''
  if (meta) {
    const backfilled = validDate(row[meta.dateField])
    if (!registeredAt) {
      registeredAt = backfilled
      if (!backfilled) {
        remarks.push('早期条目缺少业务日期，登记时刻留空待补登')
      }
    }
  } else if (!registeredAt) {
    remarks.push('早期条目缺少业务日期，登记时刻留空待补登')
  }

  const pending = meta ? meta.pendingStatuses.includes(status) : Boolean(row.pending)
  const abnormal = meta ? meta.abnormalStatuses.includes(status) : Boolean(row.abnormal)

  // 早年标记与归档状态不符：记下拨正缘由，对外只呈现重算后的结论。
  if (archived && meta) {
    if (Boolean(row.pending) !== pending) {
      remarks.push(`待办标记由旧值「${row.pending ? '是' : '否'}」按归档状态拨正为「${pending ? '是' : '否'}」`)
    }
    if (Boolean(row.abnormal) !== abnormal) {
      remarks.push(`异常标记由旧值「${row.abnormal ? '是' : '否'}」按归档状态拨正为「${abnormal ? '是' : '否'}」`)
    }
    const tailField = meta.fields[meta.fields.length - 1]
    if (tailField && String(row[tailField] ?? '') !== status) {
      remarks.push(`「${tailField}」旧值与归档状态不一致，已同步为「${status}」`)
    }
  }

  const next: EntryRow = {
    ...row,
    status,
    pending,
    abnormal,
    rev: typeof row.rev === 'number' && Number.isFinite(row.rev) ? row.rev : 0,
    registeredAt,
    remark: Array.from(new Set(remarks)).join('；'),
  }

  // 末位业务字段（管线状态/检修状态/…）与归档状态同源，避免「页面已办结、另存留旧值」。
  if (meta) {
    next[meta.fields[meta.fields.length - 1]] = status
  }
  return next
}

function seedAsRows(key: string): EntryRow[] {
  return (SEED_ROWS[key] ?? []).map((row) => row as EntryRow)
}

function migrate(raw: Record<string, EntryRow[]>): Record<string, EntryRow[]> {
  const ledger = readLedger()
  const migratedAt = nowIso()
  const next: Record<string, EntryRow[]> = {}
  for (const meta of MODULE_BY_KEY.values()) {
    const rows = raw[meta.key] ?? []
    const snapshotBefore = clone(rows)
    next[meta.key] = rows.map((row) => canonicalize(row, meta.key, true))
    ledger.archive.push({ key: meta.key, reason: ARCHIVE_REASON_LEGACY, at: migratedAt, rows: snapshotBefore })
  }
  writeLedger(ledger)
  return next
}

function readLedger(): Ledger {
  if (typeof window === 'undefined' || !window.localStorage) {
    return emptyLedger()
  }
  const raw = window.localStorage.getItem(LEDGER_KEY)
  if (!raw) {
    return emptyLedger()
  }
  try {
    const parsed = JSON.parse(raw) as Partial<Ledger>
    return {
      events: Array.isArray(parsed.events) ? (parsed.events as EventRecord[]) : [],
      nextEventSeq: typeof parsed.nextEventSeq === 'number' ? parsed.nextEventSeq : 1,
      archive: Array.isArray(parsed.archive) ? parsed.archive : [],
    }
  } catch {
    return emptyLedger()
  }
}

function writeLedger(ledger: Ledger): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(LEDGER_KEY, JSON.stringify(ledger))
  }
}

function seedAll(): Record<string, EntryRow[]> {
  const all: Record<string, EntryRow[]> = {}
  for (const meta of MODULE_BY_KEY.values()) {
    all[meta.key] = seedAsRows(meta.key)
  }
  return all
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = seedAll()
  if (typeof window === 'undefined' || !window.localStorage) {
    return migrate(fallback)
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const migrated = migrate(fallback)
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: SCHEMA_VERSION, rows: migrated }),
    )
    return migrated
  }
  let versioned: { version?: number; rows?: Record<string, EntryRow[]> }
  try {
    versioned = JSON.parse(raw) as { version?: number; rows?: Record<string, EntryRow[]> }
  } catch {
    const migrated = migrate(fallback)
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: SCHEMA_VERSION, rows: migrated }),
    )
    return migrated
  }

  // v1：值直接就是 Record<key, rows>，整库迁移并归档。
  if (!versioned.version || !versioned.rows) {
    const legacy = (versioned as unknown as Record<string, EntryRow[]>) ?? {}
    const merged: Record<string, EntryRow[]> = {}
    for (const meta of MODULE_BY_KEY.values()) {
      merged[meta.key] = legacy[meta.key] ? clone(legacy[meta.key]) : seedAsRows(meta.key)
    }
    const migrated = migrate(merged)
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: SCHEMA_VERSION, rows: migrated }),
    )
    return migrated
  }

  // v2：补齐后续新增模块、给缺失登记要素的记录补做规范化（不重复归档）。
  const stored = versioned.rows
  let changed = false
  for (const meta of MODULE_BY_KEY.values()) {
    if (!stored[meta.key]) {
      stored[meta.key] = seedAsRows(meta.key).map((row) => canonicalize(row, meta.key, true))
      changed = true
      continue
    }
    stored[meta.key] = stored[meta.key].map((row) => {
      const fixed = canonicalize(row, meta.key, false)
      if (fixed.pending !== row.pending || fixed.abnormal !== row.abnormal) {
        changed = true
      }
      return fixed
    })
  }
  if (changed) {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: SCHEMA_VERSION, rows: stored }),
    )
  }
  return stored
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

/**
 * 原子提交：expectedRev 必须与库内当前版本一致，否则判定为并发，整笔不落库。
 * 一次可提交多个模块的改动（管线迁出连同保养台账、值班台账一起提交、一起回退）。
 */
export function commitRows(
  changes: { key: string; rows: EntryRow[]; expectedRev: Record<number, number> }[],
): boolean {
  const snapshot = allRows()
  for (const change of changes) {
    const current = snapshot[change.key] ?? []
    for (const [id, rev] of Object.entries(change.expectedRev)) {
      const row = current.find((item) => Number(item.id) === Number(id))
      if (!row || row.rev !== rev) {
        // 后到的一笔：整笔回退，任何模块都不写。
        return false
      }
    }
  }

  const next = { ...snapshot }
  for (const change of changes) {
    next[change.key] = change.rows
  }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: SCHEMA_VERSION, rows: next }),
    )
  }
  return true
}

export function saveRows(key: string, rows: EntryRow[]): void {
  // 旧接口保留给重置等场景：提交时不带版本预期，不参与并发裁决。
  commitRows([{ key, rows, expectedRev: {} }])
}

export function resetRows(key: string): EntryRow[] {
  const rows = seedAsRows(key).map((row) => canonicalize(row, key, false))
  saveRows(key, rows)
  return rows
}

/** 追加一条业务事件。重复业务键只落一次（同一管线重复办理迁出在此幂等）。 */
export function appendEvent(
  event: Omit<EventRecord, 'seq'>,
): { appended: boolean; seq: number } {
  const ledger = readLedger()
  if (ledger.events.some((item) => item.idempotencyKey === event.idempotencyKey)) {
    return { appended: false, seq: 0 }
  }
  const seq = ledger.nextEventSeq
  ledger.events.push({ ...event, seq })
  ledger.nextEventSeq = seq + 1
  writeLedger(ledger)
  return { appended: true, seq }
}

export function listEvents(key?: string): EventRecord[] {
  const ledger = readLedger()
  return key ? ledger.events.filter((event) => event.key === key) : ledger.events
}

export function storageKey(): string {
  return STORAGE_KEY
}

export function ledgerKey(): string {
  return LEDGER_KEY
}

/** 供动作服务构造新行（保养/值班侧写）时复用同一套规范化口径。 */
export function normalizeRow(row: EntryRow, key: string): EntryRow {
  return canonicalize(row, key, false)
}

export function nextRowId(key: string): number {
  const rows = listRows(key)
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

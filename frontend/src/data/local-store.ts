import { MODULES } from './modules'
import { buildRegistrationArchives, normalizeAll } from './reconcile'
import { SEED_ARCHIVE, SEED_ROWS } from './seed'
import type { ArchiveRow, EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都在。
const STORAGE_KEY = 'urban-utility-tunnel:entries'
const ARCHIVE_KEY = 'urban-utility-tunnel:archives'
const JOURNAL_KEY = 'urban-utility-tunnel:action-journal'
const SCHEMA_VERSION = 2

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

type StoreState = {
  version: number
  tables: Record<string, EntryRow[]>
  archives: ArchiveRow[]
  /** 已入账动作时刻：同一时刻的第二笔提交整笔回退。 */
  journal: string[]
}

let cache: StoreState | null = null
// 串行化所有写动作：同一时刻只允许一笔在改，后到的整笔失败，由服务层回退提示。
let inflight: string | null = null
const JOURNAL_LIMIT = 500

function seedState(): StoreState {
  const archives = clone(SEED_ARCHIVE as ArchiveRow[])
  const registration = buildRegistrationArchives(SEED_ROWS.pipeline ?? [])
  for (const item of registration) {
    if (!archives.some((old) => old.refId === item.refId && old.kind === item.kind)) {
      item.id = archives.length + 1
      archives.push(item)
    }
  }
  const tables = normalizeAll(MODULES, clone(SEED_ROWS), archives)
  return { version: SCHEMA_VERSION, tables, archives, journal: [] }
}

function migrate(rawTables: Record<string, EntryRow[]>, oldArchives: ArchiveRow[] | null): StoreState {
  // 旧版本数据先登记归档（存量按登记时刻落库），再统一 normalize 拨正。
  const archives = clone(oldArchives ?? (SEED_ARCHIVE as ArchiveRow[]))
  const seedRegistration = buildRegistrationArchives(rawTables.pipeline ?? [])
  for (const item of seedRegistration) {
    if (!archives.some((old) => old.refId === item.refId && old.kind === item.kind)) {
      item.id = archives.length + 1
      archives.push(item)
    }
  }
  const seeded: Record<string, EntryRow[]> = { ...clone(SEED_ROWS), ...rawTables }
  const tables = normalizeAll(MODULES, seeded, archives)
  return { version: SCHEMA_VERSION, tables, archives, journal: [] }
}

function persist(state: StoreState): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: state.version, tables: state.tables }))
  window.localStorage.setItem(ARCHIVE_KEY, JSON.stringify(state.archives))
  window.localStorage.setItem(JOURNAL_KEY, JSON.stringify(state.journal))
}

function readStorage(): StoreState {
  if (typeof window === 'undefined' || !window.localStorage) {
    return seedState()
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const state = seedState()
    persist(state)
    return state
  }
  try {
    const parsed = JSON.parse(raw) as
      | { version?: number; tables?: Record<string, EntryRow[]> }
      | Record<string, EntryRow[]>
    // 兼容 v1：整个值就是表集合。
    const isEnvelope = parsed && typeof parsed === 'object' && 'tables' in parsed
    const version = isEnvelope ? Number((parsed as { version?: number }).version) || 1 : 1
    const rawTables = isEnvelope
      ? ((parsed as { tables: Record<string, EntryRow[]> }).tables ?? {})
      : (parsed as Record<string, EntryRow[]>)
    // 只有带 tables 的现行信封才直读；缺 tables（裸表 v1）或版本旧都走一次性迁移。
    if (isEnvelope && version >= SCHEMA_VERSION) {
      const archivedRaw = window.localStorage.getItem(ARCHIVE_KEY)
      const archives = archivedRaw ? (JSON.parse(archivedRaw) as ArchiveRow[]) : clone(SEED_ARCHIVE as ArchiveRow[])
      const journalRaw = window.localStorage.getItem(JOURNAL_KEY)
      const journal = journalRaw ? (JSON.parse(journalRaw) as string[]) : []
      return { version: SCHEMA_VERSION, tables: rawTables, archives, journal }
    }
    const state = migrate(rawTables, null)
    persist(state)
    return state
  } catch {
    const state = seedState()
    persist(state)
    return state
  }
}

export function state(): StoreState {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function allRows(): Record<string, EntryRow[]> {
  return state().tables
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function listArchives(): ArchiveRow[] {
  return state().archives
}

/** 该动作时刻是否已经入过账：用于同一时刻第二笔提交整笔回退。 */
export function hasCommitted(token: string): boolean {
  return state().journal.includes(token)
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const current = state()
  cache = { ...current, tables: { ...current.tables, [key]: rows } }
  persist(cache)
}

/**
 * 原子提交多张表 + 归档件：要么整笔落库，要么抛错由调用方整笔回退（内存不残留半笔）。
 * token 为动作时刻标识：同一时刻已入账或另有一笔在途时，后到的整笔拒绝入账。
 */
export function commitAll(
  draft: Record<string, EntryRow[]>,
  archives: ArchiveRow[],
  token: string,
): void {
  const current = state()
  if (current.journal.includes(token)) {
    throw new Error('同一时刻的提交已先有一笔入账，本笔整笔回退')
  }
  if (inflight !== null && inflight !== token) {
    throw new Error(`同一时刻已有提交（${inflight}）处理中，本笔整笔回退，请稍后重试`)
  }
  const journal = [...current.journal, token].slice(-JOURNAL_LIMIT)
  cache = { version: SCHEMA_VERSION, tables: { ...current.tables, ...draft }, archives, journal }
  persist(cache)
}

/** 先到入账：占位成功才允许继续；同一时刻的第二笔直接被挡下。 */
export function acquire(token: string): boolean {
  if (inflight !== null) {
    return inflight === token
  }
  inflight = token
  return true
}

export function release(token: string): void {
  if (inflight === token) {
    inflight = null
  }
}

export function resetRows(key: string): EntryRow[] {
  const seeded = seedState()
  const current = state()
  const rows = seeded.tables[key] ?? []
  cache = { ...current, tables: { ...current.tables, [key]: rows } }
  persist(cache)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}

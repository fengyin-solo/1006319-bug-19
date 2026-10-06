/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

/** 归档件：登记/迁出等关键节点的不可变留档，历史取值有争议时以归档件为准。 */
export type ArchiveRow = {
  id: number
  kind: string
  refId: number
  refCode: string
  archivedAt: string
  note: string
  snapshot: EntryRow
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
  /** 每个指标按哪些状态取值：与 metrics 一一对应；标记为“本月”的指标另按日期截取当月。 */
  metricStatuses?: (string[] | null)[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

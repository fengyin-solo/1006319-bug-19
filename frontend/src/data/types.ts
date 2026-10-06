/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  /** 归档结论：唯一真相源，页面展示、在用口径、待办/异常、末位业务字段都由它派生。 */
  status: string
  pending: boolean
  abnormal: boolean
  /** 乐观锁版本：每次落库 +1，并发提交时后到的一笔整笔回退。 */
  rev: number
  /** 登记时刻（ISO 字符串）：存量按业务日期回填，早期缺项留空，原因写进备注。 */
  registeredAt: string
  /** 备注：回填缺项、按归档件拨正标记时在这里注明缘由。 */
  remark: string
  [field: string]: string | number | boolean
}

/** 只追加的业务事件：同一管线重复迁出在此被幂等拦住，只落一次。 */
export type EventRecord = {
  seq: number
  key: string
  rowId: number
  action: string
  /** 业务幂等键，如 pipeline:3:办理迁出。 */
  idempotencyKey: string
  operator: string
  at: string
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
  /** 在用/健康口径的状态集合；概览上的「在用/正常」列据此从记录重算。 */
  healthyStatuses: string[]
  /** 真正的异常态：末位「已迁出/已停用/已报废/已取消/已完工」这类正常终局不算异常。 */
  abnormalStatuses: string[]
  /** 还需要继续处理的状态：概览和各页「待办」据此重算。 */
  pendingStatuses: string[]
  /** 「本月…」类统计取数的状态，配合日期字段按当月记录重算。 */
  pendingStatusesMonthly?: string[]
  /** 回填登记时刻时使用的业务日期字段。 */
  dateField: string
}

export type ListOptions = {
  filters?: Record<string, string>
  /** 只看在用清单：pipeline 下为 已入廊∪运行中，其余模块按 healthyStatuses。 */
  activeOnly?: boolean
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionContext = {
  operator?: string
  crew?: string
  shift?: string
}

export type ActionResult = {
  ok: boolean
  message: string
  /** 并发冲突整笔回退时为 true，调用方据此提示而不是改写数据。 */
  conflict?: boolean
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: {
    name: string
    created: number
    pending: number
    abnormal: number
    healthy: number
  }[]
}

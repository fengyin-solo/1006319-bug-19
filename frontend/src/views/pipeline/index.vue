<template>
  <section class="page" data-module="pipeline">
    <header class="page-head">
      <div>
        <h2>入廊管线登记管理</h2>
        <p class="page-desc">维护入廊管线，围绕管线编号、所属舱室、管线类型、权属单位做登记、筛选与状态流转。统计按当前台账记录重算，已迁出不再计入在用。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记入廊管线</button>
        <button class="btn" type="button" @click="exportRows">导出入廊管线登记清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
      <span class="legend-item">归档件：{{ archiveCount }} 份（历史争议以归档件为准，仅留档备查）</span>
    </p>

    <div class="scope-bar">
      <button
        class="btn"
        :class="{ primary: scope === 'all' }"
        type="button"
        @click="switchScope('all')"
      >
        全部台账
      </button>
      <button
        class="btn"
        :class="{ primary: scope === 'inUse' }"
        type="button"
        @click="switchScope('inUse')"
      >
        在用清单（按记录重算）
      </button>
    </div>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>在役</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] === '' || row[column] == null ? '—' : row[column] }}</td>
          <td>{{ inService(row) ? '在用' : '非在用' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">
            {{ scope === 'inUse' ? '当前条件下没有在役入廊管线（已迁出按记录排除）' : '暂无入廊管线登记数据，可先登记入廊管线' }}
          </td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span v-if="scope === 'inUse'">在用 {{ total }} 条（运行中 {{ runningCount }} 条，已迁出不计入）</span>
      <span v-else>共 {{ total }} 条入廊管线登记记录（其中在役 {{ inUseCount }} 条）</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  moduleStats,
  runAction as applyAction,
} from '@/api/local-service'
import { listArchives } from '@/data/local-store'
import { isPipelineInService } from '@/data/reconcile'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('pipeline')
// 表格只展示登记字段；迁出日期、备注属于留档补充列，由状态与在役列体现口径。
const columns = ["管线编号", "所属舱室", "管线类型", "权属单位", "入廊日期", "设计容量", "对接联系人", "管线状态"]
const actions = ["登记入廊", "确认运行", "办理迁出"]
const statuses = ["待登记", "已入廊", "运行中", "已迁出"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const scope = ref<'all' | 'inUse'>('all')
const filterFields = columns.slice(0, 3)

const stats = computed(() => {
  void rows.value
  return moduleStats(meta.key)
})
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)
const archiveCount = computed(() => listArchives().length)
const inUseCount = computed(() => rows.value.filter(isPipelineInService).length)
const runningCount = computed(() => rows.value.filter((row) => row.status === '运行中').length)

function inService(row: EntryRow): boolean {
  return isPipelineInService(row)
}

function switchScope(next: 'all' | 'inUse') {
  scope.value = next
  reload()
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  // 另存与页面读同一份：沿用当前口径与过滤条件，导出条数与页脚一致。
  downloadEntries(meta.key, filters.value, scope.value)
}

function openCreate() {
  errorMessage.value = '入廊管线登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  errorMessage.value = result.message
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value, scope.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '入廊管线登记列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.scope-bar {
  display: flex;
  gap: 8px;
  margin: 8px 0 12px;
}
</style>

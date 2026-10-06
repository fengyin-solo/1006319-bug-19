<template>
  <section class="page" data-module="pipeline">
    <header class="page-head">
      <div>
        <h2>入廊管线登记管理</h2>
        <p class="page-desc">维护入廊管线，围绕管线编号、所属舱室、管线类型、权属单位做登记、筛选与状态流转。</p>
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
      <span class="legend-item legend-note">在用口径＝已入廊∪运行中（已迁出、待登记不计）</span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label class="filter-item">
        <span>台账口径</span>
        <select v-model="scope">
          <option value="all">全部登记</option>
          <option value="active">在用清单</option>
        </select>
      </label>
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
          <th>当前状态</th>
          <th>登记时刻</th>
          <th>备注</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td>{{ row.registeredAt || '—' }}</td>
          <td>{{ row.remark || '—' }}</td>
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
          <td :colspan="columns.length + 4" class="empty-state">
            {{ scope === 'active' ? '当前口径下没有在用入廊管线' : '暂无入廊管线登记数据，可先登记入廊管线' }}
          </td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>
        共 {{ total }} 条{{ scope === 'active' ? '在用' : '登记' }}记录；
        其中运行中管线 <strong>{{ runningCount }}</strong> 条（按记录实时重算），
        在用合计 <strong>{{ activeCount }}</strong> 条
      </span>
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
import { useSessionStore } from '@/stores/session'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('pipeline')
const columns = ['管线编号', '所属舱室', '管线类型', '权属单位', '入廊日期', '设计容量', '对接联系人', '管线状态']
const actions = ['登记入廊', '确认运行', '办理迁出']
const statuses = ['待登记', '已入廊', '运行中', '已迁出']
const stats = ref<{ label: string; value: number }[]>([])

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const scope = ref<'all' | 'active'>('all')
const filterFields = columns.slice(0, 3)
const session = useSessionStore()
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)
// 在用条数按全量记录重算，不做累加；迁出一条，清单与页脚就少一条。
const activeCount = computed(() => listEntries('pipeline', { activeOnly: true }).total)
const runningCount = computed(
  () => listEntries('pipeline').items.filter((row) => String(row.status) === '运行中').length,
)

function resetFilters() {
  filters.value = {}
  scope.value = 'all'
  reload()
}

function exportRows() {
  // 另存清单与当前口径、过滤结果读同一份，条数与页面一致。
  downloadEntries('pipeline', { filters: filters.value, activeOnly: scope.value === 'active' })
}

function openCreate() {
  errorMessage.value = '入廊管线登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action, {
    operator: session.operator,
    shift: session.shiftLabel,
  })
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    stats.value = moduleStats(meta.key)
    const payload = listEntries(meta.key, {
      filters: filters.value,
      activeOnly: scope.value === 'active',
    })
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '入廊管线登记列表读取失败'
  }
}

onMounted(reload)
</script>

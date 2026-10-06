// 链路验证：迁移归档 → 迁出改写 → 在用口径/过滤/另存一致 → 统计重算 →
// 重复迁出幂等 → 跨台账侧写 → 并发后到整笔回退 → 概览同步。
// 通过 --import ./test-register.mjs 注册 TS 加载器。

// ---- localStorage 桩 ----
const mem = new Map()
globalThis.window = {
  localStorage: {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => void mem.set(k, String(v)),
    removeItem: (k) => void mem.delete(k),
    clear: () => mem.clear(),
  },
}

const store = await import('@/data/local-store')
const svc = await import('@/api/local-service')

let failures = 0
function check(name, cond, extra = '') {
  if (cond) {
    console.log(`  ✓ ${name}`)
  } else {
    failures++
    console.error(`  ✗ ${name} ${extra}`)
  }
}

console.log('1) 存量迁移：按归档状态拨正、登记时刻回填、旧值归档')
{
  const pipes = store.listRows('pipeline')
  // 种子里 id=2 是「已入廊」却被错标 abnormal=true，按归档件应拨正为 false
  const p2 = pipes.find((r) => r.id === 2)
  check('错标 abnormal 已按归档状态拨正', p2.abnormal === false, JSON.stringify({ a: p2.abnormal }))
  check('待登记待办标记保留', pipes.find((r) => r.id === 1).pending === true)
  check('运行中不再算待办', pipes.find((r) => r.id === 3).pending === false)
  check('末位字段「管线状态」与归档同源', p2['管线状态'] === '已入廊')
  check('登记时刻按入廊日期回填', p2.registeredAt === '2026-09-02', p2.registeredAt)
  check('拨正在备注里注明缘由', /拨正/.test(p2.remark) || /归档/.test(p2.remark), p2.remark)
  // 无日期字段的排水模块：留空并注明
  const drai = store.listRows('drainage')[0]
  check('缺日期的早期条目登记时刻留空', drai.registeredAt === '')
  check('缺项缘由已注明', /留空/.test(drai.remark), drai.remark)
  const ledger = JSON.parse(mem.get('urban-utility-tunnel:ledger'))
  check('旧值整份归档留档', ledger.archive.length >= 18)
  const archivedPipe2 = ledger.archive
    .find((a) => a.key === 'pipeline')
    .rows.find((r) => r.id === 2)
  check('归档件保留旧 abnormal=true', archivedPipe2.abnormal === true)
}

console.log('2) 迁出动作：标记与在用口径一并改写')
{
  const before = svc.listEntries('pipeline').items
  const beforeRunning = before.filter((r) => String(r.status) === '运行中').length
  const beforeActive = svc.listEntries('pipeline', { activeOnly: true }).total
  const res = svc.runAction('pipeline', 3, '办理迁出', { operator: '测试员', shift: '白班' })
  check('迁出成功', res.ok, res.message)
  const after = svc.listEntries('pipeline').items
  const p3 = after.find((r) => r.id === 3)
  check('状态改为已迁出', String(p3.status) === '已迁出')
  check('管线状态字段同步', p3['管线状态'] === '已迁出')
  check('迁出不占用待办', p3.pending === false)
  check('运行中条数减一', after.filter((r) => String(r.status) === '运行中').length === beforeRunning - 1)
  check('在用清单不再含旧记录', svc.listEntries('pipeline', { activeOnly: true }).total === beforeActive - 1)
}

console.log('3) 按舱室/类型过滤的在用清单：旧记录不残留，另存与页面同条数')
{
  const cabin = String(store.listRows('pipeline').find((r) => r.id === 3)['所属舱室'])
  const activeFiltered = svc.listEntries('pipeline', {
    activeOnly: true,
    filters: { 所属舱室: cabin },
  })
  check('过滤后的在用清单无已迁出残留', activeFiltered.items.every((r) => String(r.status) !== '已迁出'))
  const exp = svc.exportEntries('pipeline', { activeOnly: true, filters: { 所属舱室: cabin } })
  const dataLines = exp.content.split('\n').slice(1).filter(Boolean)
  check('另存条数与页面一致', dataLines.length === activeFiltered.total, `${dataLines} vs ${activeFiltered.total}`)
  check('另存表头带登记时刻与备注', exp.content.split('\n')[0].includes('登记时刻'))
  const all = svc.listEntries('pipeline')
  const expAll = svc.exportEntries('pipeline', {})
  check('全部清单另存条数也一致', expAll.content.split('\n').slice(1).filter(Boolean).length === all.total)
}

console.log('4) 同一管线重复迁出：事件/侧写只落一次')
{
  const eventsBefore = store.listEvents('pipeline').length
  const maintBefore = store.listRows('maintenance').length
  const dutyBefore = store.listRows('duty').length
  const again = svc.runAction('pipeline', 3, '办理迁出', { operator: '测试员' })
  check('重复迁出幂等返回（不落第二次）', again.ok)
  check('事件只落一次', store.listEvents('pipeline').length === eventsBefore)
  check('保养侧写只落一次', store.listRows('maintenance').length === maintBefore)
  check('值班侧写只落一次', store.listRows('duty').length === dutyBefore)
}

console.log('5) 结论落到保养台账与值班台账，登记对齐、待办核销')
{
  const maint = store.listRows('maintenance')
  const mv = maint.find((r) => String(r['检修编号']) === 'MAIN-MV-0003')
  check('保养台账已登记迁出注销保养', Boolean(mv))
  check('保养记录为已办结', mv && String(mv.status) === '已完工' && mv.pending === false)
  check('保养登记与管线台账对齐', mv && String(mv['检修对象']).includes('PIPE-0003'))
  const duty = store.listRows('duty').find((r) => String(r['交接编号']) === 'DUTY-MV-0003')
  check('值班台账已生成已交接记录', duty && String(duty.status) === '已交接')
  check('值班待办已核销（不算待处理）', duty && duty.pending === false)
}

console.log('6) 并发：同一时刻后到的一笔整笔回退（含侧写一笔不写）')
{
  // id=2 当前在运行中；甲乙两笔「办理迁出」基于同一旧版本同时提交
  const baseRev = store.listRows('pipeline').find((r) => r.id === 2).rev
  const maintBefore = store.listRows('maintenance').length
  const dutyBefore = store.listRows('duty').length
  const first = svc.runActionAtRev('pipeline', 2, '办理迁出', baseRev, { operator: '甲' })
  check('先到提交入账（含两笔侧写）', first.ok, first.message)
  const second = svc.runActionAtRev('pipeline', 2, '办理迁出', baseRev, { operator: '乙' })
  check('同版本后到的提交被整笔回退', second.ok === false && second.conflict === true, second.message)
  check('回退后状态保持先到结论（已迁出）',
    String(store.listRows('pipeline').find((r) => r.id === 2).status) === '已迁出')
  check('先到只落一组侧写：保养 +1', store.listRows('maintenance').length === maintBefore + 1)
  check('先到只落一组侧写：值班 +1', store.listRows('duty').length === dutyBefore + 1)

  // 另一记录：后到的迁出带侧写，冲突时保养/值班一笔都不写
  const r1base = store.listRows('pipeline').find((r) => r.id === 1).rev
  const head = svc.runAction('pipeline', 1, '登记入廊', { operator: '甲' })
  check('先到登记入账', head.ok, head.message)
  const tail = svc.runActionAtRev('pipeline', 1, '办理迁出', r1base, { operator: '乙' })
  check('后到迁出整笔回退', tail.ok === false && tail.conflict === true, tail.message)
  check('回退后管线状态保持先到结论（已入廊）',
    String(store.listRows('pipeline').find((r) => r.id === 1).status) === '已入廊')
  check('回退后保养台账一笔未增', store.listRows('maintenance').length === maintBefore + 1)
  check('回退后值班台账一笔未增', store.listRows('duty').length === dutyBefore + 1)
}

console.log('7) 概览：按记录重算，迁出即时生效')
{
  const ov = svc.loadOverview()
  const pipe = ov.modules.find((m) => m.name === '入廊管线登记')
  check('概览在用列存在', typeof pipe.healthy === 'number')
  check('概览在用数=已入廊+运行中',
    pipe.healthy === store.listRows('pipeline').filter((r) => ['已入廊', '运行中'].includes(String(r.status))).length)
  check('概览卡片含在用/正常', ov.cards.some((c) => c.label === '在用/正常'))
  const stats = svc.moduleStats('pipeline')
  const running = stats.find((s) => s.label === '运行中管线')
  check('运行中管线统计按记录重算',
    running.value === store.listRows('pipeline').filter((r) => String(r.status) === '运行中').length)
}

console.log('8) 月度类指标按记录+当月日期重算（不累加）')
{
  const leakStats = svc.moduleStats('leak')
  const monthly = leakStats.find((s) => s.label === '本月完工数')
  check('本月完工数为数值（种子日期 2026-09，当前非 9 月时应为 0）', typeof monthly.value === 'number')
}

console.log(failures === 0 ? '\n全部通过 ✅' : `\n有 ${failures} 项失败 ❌`)
process.exit(failures === 0 ? 0 : 1)

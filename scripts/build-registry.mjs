// 自给自足版 DSH 插件市场索引生成器
// 数据源：GitHub Search API（topic:dsh-plugin）
// 突破单 query 1000 条上限：stars 分段 + 时间窗口二分
// 用法：
//   node scripts/build-registry.mjs                    全量重建（冷启动 ~1.5h，需 token）
//   INCREMENTAL_DAYS=3 node scripts/build-registry.mjs 增量（只拉最近 3 天 pushed 的仓库，与旧索引合并）
// 环境变量：GH_TOKEN/GITHUB_TOKEN（CI 自动提供，Search 限额 30/min；无 token 10/min）
//           MAX_PAGES（默认 100，本地测试可设小）

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'registry.json')

const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || ''
const INCREMENTAL_DAYS = Number(process.env.INCREMENTAL_DAYS || 0)
const MAX_PAGES = Number(process.env.MAX_PAGES || 100)
const PER_PAGE = 100
const TOPIC = 'dsh-plugin'
const SEARCH_LIMIT = 1000
const RATE_PER_MIN = TOKEN ? 30 : 10

// stars 分段表（第一维）；MIN_STARS 环境变量可过滤低星段（快速 seed）
const MIN_STARS = Number(process.env.MIN_STARS || 0)
const ALL_SEGMENTS = [
  { min: 1000, max: null },
  { min: 100, max: 999 },
  { min: 10, max: 99 },
  { min: 1, max: 9 },
  { min: 0, max: 0 },
]
const SEGMENTS = ALL_SEGMENTS.filter((s) => MIN_STARS <= 0 || s.min >= MIN_STARS || (s.min === 0 && MIN_STARS <= 1))

async function api(url) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      headers: TOKEN
        ? { authorization: 'Bearer ' + TOKEN, 'user-agent': 'dsh-market-indexer' }
        : { 'user-agent': 'dsh-market-indexer' },
      signal: AbortSignal.timeout(60000),
    })
    if (res.status === 403 || res.status === 429) {
      const retry = Number(res.headers.get('retry-after')) || Math.ceil(60000 / RATE_PER_MIN) + 1
      console.error(`限速（HTTP ${res.status}），等待 ${retry}s 后重试…`)
      await new Promise((r) => setTimeout(r, retry * 1000))
      continue
    }
    if (res.status >= 500 || res.status === 408) {
      console.error(`服务器错误（HTTP ${res.status}），等待 8s 后重试…`)
      await new Promise((r) => setTimeout(r, 8000))
      continue
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`)
    return res.json()
  }
}

function sinceClause() {
  if (!INCREMENTAL_DAYS) return ''
  const d = new Date(Date.now() - INCREMENTAL_DAYS * 86400000)
  return ' pushed:>=' + d.toISOString().slice(0, 10)
}

function rangeQuery(seg) {
  const range = seg.max === null
    ? 'stars:>=' + seg.min
    : (seg.min === seg.max ? 'stars:' + seg.min : `stars:${seg.min}..${seg.max}`)
  const time = seg.timeRange ? ' pushed:' + seg.timeRange : sinceClause()
  return `topic:${TOPIC} ${range}${time}`
}

function midpointDate(a, b) {
  const t1 = Date.parse(a), t2 = Date.parse(b)
  if (isNaN(t1) || isNaN(t2) || t2 <= t1) return ''
  return new Date(Math.floor((t1 + t2) / 2)).toISOString().slice(0, 10)
}

function splitSegment(seg) {
  if (seg.timeRange) {
    const [a, b] = seg.timeRange.split('..')
    const mid = midpointDate(a, b)
    if (!mid || mid <= a || mid >= b) return null
    return [
      Object.assign({}, seg, { timeRange: a + '..' + mid }),
      Object.assign({}, seg, { timeRange: mid + '..' + b }),
    ]
  }
  if (seg.max === null) {
    const hi = seg.min * 2 - 1
    return [
      { min: seg.min, max: hi },
      { min: hi + 1, max: null },
    ]
  }
  if (seg.min === seg.max) {
    const end = new Date().toISOString().slice(0, 10)
    const mid = midpointDate('2008-01-01', end)
    if (!mid) return null
    return [
      { min: seg.min, max: seg.max, timeRange: '2008-01-01..' + mid },
      { min: seg.min, max: seg.max, timeRange: mid + '..' + end },
    ]
  }
  const mid = Math.floor((seg.min + seg.max) / 2)
  if (mid <= seg.min || mid >= seg.max) return null
  return [
    { min: seg.min, max: mid },
    { min: mid + 1, max: seg.max },
  ]
}

async function fetchSegment(seg) {
  const collected = []
  let total = 0
  const q = rangeQuery(seg)
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&per_page=${PER_PAGE}&page=${page}`
    let j
    try {
      j = await api(url)
    } catch (e) {
      // HTTP 422 = 超出该查询的结果上限（单查询最多 1000 条）。
      // 表示该段已取满，交由 buildFull 分裂继续；不是致命错误。
      if (String(e && e.message || '').includes('422')) break
      throw e
    }
    total = Number(j.total_count) || total
    // 收集阶段不过滤 fork/archived：GitHub total_count 是近似值，
    // 提前过滤会让 items 永远小于 total，导致无谓的多层分裂。
    // 全部收集完后统一过滤。
    for (const it of j.items || []) collected.push(it)
    if ((j.items || []).length < PER_PAGE) break
  }
  return { items: collected, total }
}

function normalize(it) {
  return {
    full_name: it.full_name,
    name: it.name,
    description: it.description || '',
    html_url: it.html_url,
    stargazers_count: it.stargazers_count || 0,
    updated_at: it.updated_at || '',
    created_at: it.created_at || '',
    default_branch: it.default_branch || '',
    topics: Array.isArray(it.topics) ? it.topics : [],
    license: it.license && it.license.spdx_id ? it.license.spdx_id : '',
    registry_seen_at: new Date().toISOString(),
  }
}

async function buildFull() {
  const seen = new Map()
  const stack = SEGMENTS.slice()
  let segmentsDone = 0
  while (stack.length) {
    const seg = stack.pop()
    const { items, total } = await fetchSegment(seg)
    // 分裂判定：超过单查询 1000 条上限（items>=1000）或未达到该段申报总量
    // （total 为近似值，仅作提示；真正收敛靠 422/不满页的自然截断）。
    if (items.length >= SEARCH_LIMIT || items.length < total) {
      const sub = splitSegment(seg)
      if (sub) {
        console.error(`段 ${rangeQuery(seg)} 未取全（${items.length}/${total}），分裂为 ${sub.length} 个子段继续`)
        stack.push(...sub)
        continue
      }
      console.error(`段 ${rangeQuery(seg)} 未取全（${items.length}/${total}）但无法继续分裂`)
    }
    for (const it of items) seen.set(it.full_name, it)
    segmentsDone++
    if (segmentsDone % 5 === 0) console.error(`已扫描 ${segmentsDone} 个段，累计 ${seen.size} 个仓库`)
  }
  return [...seen.values()]
}

function mergeWithPrev(fresh) {
  if (!existsSync(OUT)) return fresh
  let prev = []
  try { prev = JSON.parse(readFileSync(OUT, 'utf8')).repos || [] } catch (e) { prev = [] }
  const map = new Map(prev.map((r) => [r.full_name, r]))
  for (const r of fresh) map.set(r.full_name, r)
  return [...map.values()]
}

async function main() {
  const started = Date.now()
  console.error(`模式：${INCREMENTAL_DAYS ? `增量（最近 ${INCREMENTAL_DAYS} 天 pushed）` : '全量'} · token：${TOKEN ? '有' : '无（限速 10/min）'} · 目标：topic:${TOPIC}`)
  const fresh = await buildFull()
  console.error(`扫描完成：${fresh.length} 个仓库（未合并）`)
  // 无论全量/增量都合并旧索引：GitHub 深分页可能部分完成，
  // 直接替换会丢失已有条目；合并保证只增不减（同名条目用新数据刷新）。
  let repos = mergeWithPrev(fresh)
  repos = repos.filter((r) => !r.fork && !r.archived)
  repos.sort((a, b) => (b.stargazers_count || 0) - (a.stargazers_count || 0))
  const doc = {
    generated_at: new Date().toISOString(),
    count: repos.length,
    source: 'self-hosted',
    mode: INCREMENTAL_DAYS ? 'incremental' : 'full',
    repos,
  }
  mkdirSync(ROOT, { recursive: true })
  writeFileSync(OUT, JSON.stringify(doc))
  console.error(`已写入 ${OUT}：${repos.length} 个插件（耗时 ${((Date.now() - started) / 1000).toFixed(0)}s）`)
}

main().catch((e) => { console.error('失败：', e); process.exit(1) })
import { createPreviewStore } from '../frontend/src/android-preview/store.js'
import { adminPage } from './admin.js'
import { Failure } from './sync.js'

const collections = { subscriptions: 'subscriptions', categories: 'categories', 'payment-methods': 'payment_methods', currencies: 'currencies', bundles: 'bundles' }
const references = ['category_id', 'payment_method_id', 'bundle_id']

// The original desktop UI uses numeric IDs. The first sequence number is a
// permanent numeric alias for a sync UUID, even after renewals and APK edits.
async function readDesktop(db, username) {
  const { results } = await db.prepare(
    'SELECT c.*, first.seq AS web_id FROM current_records c JOIN changes first ON first.id=c.id AND first.version=1 WHERE c.deleted=0 ORDER BY first.seq'
  ).all()
  const store = createPreviewStore()
  const state = store.state
  for (const field of Object.values(collections)) state[field] = []
  Object.assign(state, { rates: { CNY: 1 }, logs: [], notifications: [] })
  const byUuid = new Map(results.map(r => [r.id, r.web_id]))
  const byNumber = new Map(results.map(r => [r.web_id, r]))
  for (const row of results) {
    const data = JSON.parse(row.data)
    if (row.kind === 'preferences') Object.assign(state.user, data)
    const field = collections[row.kind]
    if (!field) continue
    if (row.kind === 'subscriptions') {
      data._version = row.version
      data.created_at ||= data.start_date || ''
    }
    if (row.kind === 'subscriptions')
      for (const key of references) data[key] = byUuid.get(data[key]) ?? null
    if (row.kind === 'currencies' && data.rate_to_base > 0) state.rates[data.code] = data.rate_to_base
    state[field].push({ ...data, id: row.web_id })
  }
  Object.assign(state.user, await db.prepare('SELECT theme,locale FROM desktop_appearance WHERE id=1').first())
  state.user.username = username
  state.user.category_order = (state.user.category_order || []).map(id => byUuid.get(id)).filter(Boolean)
  store.loadState(state)
  return { store, byNumber }
}

export async function desktop(req, env, url) {
  const method = req.method.toLowerCase(), path = url.pathname
  if (['/api/logs', '/api/worker/notifications', '/api/worker/scan', '/api/worker/settings'].includes(path)) return adminPage(req, env, url)
  if (method === 'get' && path === '/api/system/version-check') return { update_available: false }
  const read = /^\/api\/(auth\/me|dashboard|subscriptions(?:\/export\.csv)?|categories|payment-methods|currencies|bundles|icons\/library|reports\/[\w.-]+)$/
  const write = { post: /^\/api\/(subscriptions(?:\/(reorder|import-csv|\d+\/renew))?|bundles)$/, put: /^\/api\/subscriptions\/\d+$/, delete: /^\/api\/subscriptions\/\d+$/ }
  if (!(method === 'get' ? read : write[method])?.test(path)) throw new Failure(404, '接口不存在')
  const { store, byNumber } = await readDesktop(env.DB, env.ADMIN_USERNAME)
  const params = Object.fromEntries(url.searchParams)
  if (params.active !== undefined) params.active = params.active === 'true'
  const body = method === 'get' ? {} : await req.json()
  if (method === 'put' && body._version != null && body._version !== byNumber.get(Number(path.split('/').pop()))?.version)
    throw new Failure(409, '此订阅已更新，请刷新后重新编辑')
  if (method === 'delete' && body.password !== env.ADMIN_PASSWORD) throw new Failure(403, '密码错误')
  const original = new Map()
  for (const kind of ['subscriptions', 'categories', 'bundles'])
    for (const row of store.state[kind]) original.set(row.id, JSON.stringify(row))
  let value
  try { value = await store.request(method, path, body, params) }
  catch (error) { throw new Failure(422, error.message) }
  if (method === 'get') return path.endsWith('.csv') ? new Response(value, { headers: { 'Content-Type': 'text/csv;charset=utf-8' } }) : value

  const changed = [], uuids = new Map([...byNumber].map(([n, row]) => [n, row.id]))
  for (const kind of ['categories', 'bundles', 'subscriptions']) {
    for (const row of store.state[kind]) {
      if (!uuids.has(row.id)) uuids.set(row.id, crypto.randomUUID())
      if (original.get(row.id) !== JSON.stringify(row)) changed.push({ kind, row })
      original.delete(row.id)
    }
  }
  for (const id of original.keys()) changed.push({ kind: byNumber.get(id).kind, row: { id }, deleted: true })
  if (!changed.length) return value
  const statements = changed.map(({ kind, row, deleted }) => {
    const prior = byNumber.get(row.id)
    if (prior?.readonly) throw new Failure(403, '系统项目不能修改')
    const data = { ...row }
    delete data.id
    delete data._version
    if (kind === 'subscriptions' && !deleted)
      for (const key of references) data[key] = uuids.get(data[key]) ?? null
    // UNIQUE(id,version) aborts the whole D1 batch on a concurrent write.
    return env.DB.prepare('INSERT INTO changes(id,kind,version,deleted,data,device,created_at) VALUES(?,?,?,?,?,?,strftime(\'%Y-%m-%dT%H:%M:%fZ\',\'now\')) RETURNING seq')
      .bind(uuids.get(row.id), kind, (prior?.version || 0) + 1, Number(!!deleted), JSON.stringify(data), 'desktop')
  })
  try {
    const saved = await env.DB.batch(statements)
    const index = changed.findIndex(c => c.row.id === value?.id && !byNumber.has(c.row.id))
    if (index >= 0) value.id = saved[index].results[0].seq
  } catch (error) {
    if (String(error).includes('UNIQUE')) throw new Failure(409, '记录刚刚发生变更，请刷新后重试')
    throw error
  }
  return value
}

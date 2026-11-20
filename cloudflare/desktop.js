import { createPreviewStore } from '../frontend/src/android-preview/store.js'
import { passwordOK } from './profile.js'
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
  const cache=await db.prepare('SELECT rates,rate_time,email,otp IS NOT NULL AS twofa FROM profile').first()
  state.user.email=cache.email
  state.user.totp_enabled=!!cache.twofa
  if(cache.rates) Object.assign(state.rates,JSON.parse(cache.rates))
  state.rates_updated_at=cache.rate_time
  store.loadState(state)
  return { store, byNumber }
}

export async function desktop(req, env, url) {
  const method = req.method.toLowerCase(), path = url.pathname
  if (['/api/logs', '/api/worker/notifications', '/api/worker/scan', '/api/worker/settings'].includes(path)) return adminPage(req, env, url)
  const read = /^\/api\/(auth\/me|dashboard|subscriptions(?:\/export\.csv)?|categories|payment-methods|currencies|bundles|icons\/library|reports\/[\w.-]+)$/
  const write = { post: /^\/api\/(subscriptions(?:\/(reorder|import-csv|\d+\/renew))?|bundles)$/, put: /^\/api\/subscriptions\/\d+$/, delete: /^\/api\/subscriptions\/\d+$/ }
  const extra = (method==='get' && ['/api/backup/export','/api/currencies/rate-table'].includes(path)) ||
    (method==='post' && path==='/api/backup/import') || (method==='patch' && path==='/api/me')
  if (!extra && !(method === 'get' ? read : write[method])?.test(path)) throw new Failure(404, '接口不存在')
  const { store, byNumber } = await readDesktop(env.DB, env.ADMIN_USERNAME)
  const params = Object.fromEntries(url.searchParams)
  if (params.active !== undefined) params.active = params.active === 'true'
  const body = method === 'get' ? {} : await req.json()
  if (method === 'put' && body._version != null && body._version !== byNumber.get(Number(path.split('/').pop()))?.version)
    throw new Failure(409, '此订阅已更新，请刷新后重新编辑')
  if (method === 'delete' && !await passwordOK(env,body.password)) throw new Failure(403, '密码错误')
  if(path==='/api/backup/export') {
    const {subscriptions,categories,payment_methods,bundles,currencies}=store.state
    return {subscriptions,categories,payment_methods,bundles,currencies}
  }
  if(path==='/api/me' && method==='patch') {
    const allowedThemes=['light','dark','ocean','purple','forest','auto']
    if(body.theme && !allowedThemes.includes(body.theme) || body.locale && !['en','zh','ru'].includes(body.locale)) throw new Failure(422,'外观设置无效')
    const jobs=[]
    if(body.theme || body.locale) jobs.push(env.DB.prepare('UPDATE desktop_appearance SET theme=coalesce(?,theme),locale=coalesce(?,locale) WHERE id=1').bind(body.theme || null,body.locale || null))
    const patch={}
    for(const k of ['base_currency','monthly_budget','notify_settings']) if(Object.hasOwn(body,k)) patch[k]=body[k]
    if(patch.base_currency && !store.state.currencies.some(c=>c.code===patch.base_currency)) throw new Failure(422,'基准货币无效')
    if(patch.monthly_budget!=null && !(Number.isFinite(patch.monthly_budget) && patch.monthly_budget>=0)) throw new Failure(422,'预算无效')
    if(Object.keys(patch).length) {
      const pref=[...byNumber.values()].find(r=>r.kind==='preferences')
      jobs.push(env.DB.prepare("INSERT INTO changes(id,kind,version,data,device,created_at) VALUES(?,'preferences',?,?,'desktop',?)").bind(pref.id,pref.version+1,JSON.stringify({...JSON.parse(pref.data),...patch}),new Date().toISOString()))
    }
    if(jobs.length) await env.DB.batch(jobs)
    return (await readDesktop(env.DB,env.ADMIN_USERNAME)).store.state.user
  }
  const original = new Map()
  for (const kind of ['subscriptions', 'categories', 'payment_methods','bundles','currencies'])
    for (const row of store.state[kind]) original.set(row.id, JSON.stringify(row))
  let value
  try {
    if(path==='/api/backup/import') {
      const data={...body.data,currencies:(body.data?.currencies || []).map(({id,...currency})=>currency)}
      for(const key of ['categories','payment_methods']) data[key]=(data[key] || []).map(item=>store.state[key].find(r=>r.is_system && r.name===item.name) ? {...store.state[key].find(r=>r.is_system && r.name===item.name),id:item.id} : item)
      value=store.restore(data,body.replace===true)
      let nextId=Math.max(0,...[...byNumber.keys()],...['subscriptions','bundles','payment_methods','categories'].flatMap(k=>store.state[k].map(r=>r.id)))+1
      for(const currency of store.state.currencies) if(currency.id==null || !byNumber.has(currency.id) || byNumber.get(currency.id).kind!=='currencies') currency.id=nextId++

    } else value=await store.request(method,path,body,params)
  }
  catch (error) { throw new Failure(422, error.message) }
  if (method === 'get') return path.endsWith('.csv') ? new Response(value, { headers: { 'Content-Type': 'text/csv;charset=utf-8' } }) : value

  const changed = [], uuids = new Map([...byNumber].map(([n, row]) => [n, row.id]))
  for (const kind of ['categories','payment-methods','bundles','currencies','subscriptions']) {
    for (const row of store.state[collections[kind]]) {
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

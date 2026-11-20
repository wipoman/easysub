import { Failure } from './sync.js'
import { remind } from './reminders.js'

async function settings(db, username) {
  const [appearance, prefs, currencies] = await db.batch([
    db.prepare('SELECT theme,locale FROM desktop_appearance WHERE id=1'),
    db.prepare("SELECT data,version FROM current_records WHERE kind='preferences' AND deleted=0"),
    db.prepare("SELECT json_extract(data,'$.code') AS code FROM current_records WHERE kind='currencies' AND deleted=0 ORDER BY code"),
  ])
  const row = prefs.results[0], data = JSON.parse(row.data)
  return { username, ...appearance.results[0], monthly_budget: data.monthly_budget, base_currency: data.base_currency,
    version: row.version, currencies: currencies.results.map(r => r.code) }
}

export async function adminPage(req, env, url) {
  const db = env.DB, path = url.pathname
  if (path === '/api/logs' && req.method === 'GET') {
    const after = Number(url.searchParams.get('after') || 0)
    if (!Number.isSafeInteger(after) || after < 0) throw new Failure(422, '日志游标无效')
    const incremental = url.searchParams.has('after')
    const rows = await db.prepare(`SELECT seq AS id,created_at,kind,version,deleted,device,json_extract(data,'$.name') AS name
      FROM changes WHERE device IS NOT NULL AND seq>? ORDER BY seq ${incremental ? 'ASC' : 'DESC'} LIMIT 100`).bind(after).all()
    if (!incremental) rows.results.reverse()
    return rows.results.map(r => ({ id: r.id, created_at: r.created_at, level: 'info', action: r.kind + '.' + (r.deleted ? 'delete' : r.version === 1 ? 'create' : 'update'),
      user: r.device === 'desktop' ? '网页' : '同步客户端', detail: r.name || '' }))
  }
  if (path === '/api/worker/notifications' && req.method === 'GET') {
    const rows = await db.prepare('SELECT day,channel,state,body FROM deliveries ORDER BY day DESC,channel LIMIT 100').all()
    return { telegram: !!(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID), email: !!(env.RESEND_API_KEY && env.EMAIL_FROM && env.EMAIL_TO), deliveries: rows.results }
  }
  if (path === '/api/worker/scan' && req.method === 'POST') {
    await remind(env, Date.now())
    return { ok: true }
  }
  if (path === '/api/worker/settings') {
    const current = await settings(db, env.ADMIN_USERNAME)
    if (req.method === 'GET') return current
    if (req.method === 'PUT') {
      const { theme, locale, base_currency, monthly_budget, version } = await req.json()
      if (!['auto','light','dark','ocean','purple','forest'].includes(theme) || !['zh','en','ru'].includes(locale) ||
          !current.currencies.includes(base_currency) || !(monthly_budget === null || (Number.isFinite(monthly_budget) && monthly_budget >= 0)))
        throw new Failure(422, '请检查主题、语言、基准货币和预算')
      if (current.version !== version) throw new Failure(409, '偏好已更新，请刷新后重新设置')
      const statements = [db.prepare('UPDATE desktop_appearance SET theme=?,locale=? WHERE id=1').bind(theme,locale)]
      if (base_currency !== current.base_currency || monthly_budget !== current.monthly_budget)
        statements.push(db.prepare(`INSERT INTO changes(id,kind,version,data,device,created_at)
          SELECT id,kind,version+1,json_set(data,'$.base_currency',?,'$.monthly_budget',?),'desktop',strftime('%Y-%m-%dT%H:%M:%fZ','now')
          FROM changes WHERE kind='preferences' AND version=?`).bind(base_currency,monthly_budget,version))
      try { await db.batch(statements) } catch (error) {
        if (String(error).includes('UNIQUE')) throw new Failure(409, '偏好已更新，请刷新后重试')
        throw error
      }
      return settings(db, env.ADMIN_USERNAME)
    }
  }
  throw new Failure(405, '请求方法不支持')
}

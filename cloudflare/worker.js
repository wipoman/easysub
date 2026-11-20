import { desktop } from './desktop.js'
import { hash, tokens, valid } from './auth.js'
import { capabilities, changes, push, Failure } from './sync.js'
import { remind } from './reminders.js'

async function upload(req, db) {
  const file = (await req.formData()).get('file')
  if (
    !(file instanceof File) ||
    file.size < 1 ||
    file.size > 2 * 1024 * 1024 ||
    !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)
  )
    throw new Failure(422, '支持 2 MB 以内的 PNG、JPEG、WebP 和 GIF')
  const bytes = new Uint8Array(await file.arrayBuffer()),
    id = crypto.randomUUID(),
    parts = []
  for (let i = 0; i < bytes.length; i += 65536)
    parts.push(
      db
        .prepare('INSERT INTO images VALUES (?,?,?,?)')
        .bind(id, i / 65536, file.type, bytes.slice(i, i + 65536)),
    )
  await db.batch(parts)
  return { url: '/static/icons/' + id }
}
async function icon(db, id) {
  const record = await db
    .prepare('SELECT data FROM current_records WHERE id=? AND deleted=0')
    .bind(id)
    .first()
  const source = record && JSON.parse(record.data).icon
  if (!source?.startsWith('/static/icons/'))
    throw new Failure(404, '图标不存在')
  return imageResponse(db, source.slice(14))
}
async function imageResponse(db, imageId) {
  const rows = await db
    .prepare('SELECT mime,bytes FROM images WHERE id=? ORDER BY part')
    .bind(imageId)
    .all()
  if (!rows.results.length) throw new Failure(404, '图标不存在')
  return new Response(
    new Blob(rows.results.map((r) => Uint8Array.from(r.bytes))),
    { headers: { 'Content-Type': rows.results[0].mime } },
  )
}
async function api(req, env, url) {
  const path = url.pathname
  if (
    !env.ADMIN_USERNAME ||
    !env.ADMIN_PASSWORD ||
    env.TOKEN_SECRET?.length < 32 ||
    !env.TOKEN_SECRET
  )
    throw new Failure(503, '请配置登录账号、密码及至少 32 位 TOKEN_SECRET')
  if (req.method === 'POST' && path === '/api/auth/login') {
    const allowed = await env.LOGIN_LIMIT.limit({
      key: req.headers.get('CF-Connecting-IP') || 'local',
    })
    if (!allowed.success) throw new Failure(429, '请稍后重试')
    const form = await req.formData()
    const incoming = await hash(String(form.get('password')))
    if (
      form.get('username') !== env.ADMIN_USERNAME ||
      incoming !== (await hash(env.ADMIN_PASSWORD))
    )
      throw new Failure(401, '用户名或密码错误')
    return tokens(env)
  }
  if (req.method === 'POST' && path === '/api/auth/refresh') {
    if (!(await valid((await req.json()).refresh_token, 'refresh', env)))
      throw new Failure(401, '请重新登录')
    return tokens(env)
  }
  if (
    !(await valid(
      req.headers.get('Authorization')?.match(/^Bearer (.+)$/i)?.[1],
      'access',
      env,
    ))
  )
    throw new Failure(401, '请登录')
  if (req.method === 'GET') {
    if (/^\/api\/web-icons\/[a-f0-9-]{36}$/.test(path)) return imageResponse(env.DB, path.split('/').pop())
    if (path === '/api/sync/v1/capabilities')
      return capabilities(env.DB, env.ADMIN_USERNAME)
    if (path === '/api/sync/v1/changes')
      return changes(env.DB, url.searchParams)
    if (path.startsWith('/api/sync/v1/icons/'))
      return icon(env.DB, path.split('/').pop())
  }
  if (req.method === 'POST') {
    if (path === '/api/sync/v1/push') return push(env.DB, await req.json())
    if (path === '/api/icons/upload') return upload(req, env.DB)
  }
  return desktop(req, env, url)
}
export default {
  async fetch(req, env) {
    const url = new URL(req.url)
    if (['/', '/login', '/dashboard', '/subscriptions', '/calendar', '/reports'].includes(url.pathname))
      return env.ASSETS.fetch(new Request(new URL('/index.html', url), req))
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req)
    const origin = req.headers.get('Origin')
    const headers = {
      'Cache-Control': 'no-store',
      Vary: 'Origin',
      'X-Content-Type-Options': 'nosniff',
    }
    if (origin && [url.origin, 'https://localhost'].includes(origin)) {
      Object.assign(headers, {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      })
    }
    if (req.method === 'OPTIONS')
      return new Response(null, { status: 204, headers })
    try {
      const value = await api(req, env, url)
      if (value instanceof Response) {
        for (const [k, v] of Object.entries(headers)) value.headers.set(k, v)
        return value
      }
      return Response.json(value, { headers })
    } catch (err) {
      const status = err.status || (err instanceof SyntaxError ? 400 : 500)
      if (status === 500)
        console.error('EasySub API failed', url.pathname, err.name)
      return Response.json(
        { detail: err.detail || '请求处理失败' },
        { status, headers },
      )
    }
  },
  async scheduled(event, env) {
    await remind(env, event.scheduledTime)
  },
}

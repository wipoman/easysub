import { build } from 'esbuild'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import * as runtime from 'miniflare'
import { createTransport } from '../frontend/src/sync/transport.js'
import { createLocal } from '../frontend/src/sync/local.js'
import { createPreviewStore } from '../frontend/src/android-preview/store.js'
import { remind } from './reminders.js'

test('original web/Android sync clients, lost response replay, and renewal delivery', async (t) => {
  const telegramRequests = []
  let redirectTelegram = false
  const options = {
    outboundService: async request => {
      telegramRequests.push(new URL(request.url).pathname)
      if (redirectTelegram) return Response.redirect('https://redirect.example/', 302)
      if (request.method === 'GET') return Response.json({ ok: true, result: { username: 'example_bot' } })
      assert.deepEqual(await request.json(), { chat_id: 'id', text: 'EasySub 测试通知' })
      return Response.json({ ok: true, result: { message_id: 1 } })
    },
    modules: true,
    script: (await build({ entryPoints: ['worker.js'], bundle: true, write: false, format: 'esm', target: 'es2022' })).outputFiles[0].text,
    compatibilityDate: '2026-06-01',
    d1Databases: ['DB'],
    ratelimits: {
      LOGIN_LIMIT: { namespace_id: '1001', simple: { limit: 10, period: 60 } },
    },
    bindings: {
      ADMIN_USERNAME: 'test',
      ADMIN_PASSWORD: 'local-test-only',
      TOKEN_SECRET: crypto.randomUUID(),
    },
  }
  const mf = new runtime.Miniflare(runtime.convertV4MiniflareOptions(options))
  t.after(() => mf.dispose())
  const db = await mf.getD1Database('DB')
  for (const path of ['0001_sync.sql', '0002_defaults.sql', '0003_desktop_admin.sql','0004_settings.sql','0005_delivery_item_keys.sql']) {
    const sql = await readFile('migrations/' + path, 'utf8')
    await db.batch(
      sql
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => db.prepare(s)),
    )
  }
  const base = 'https://easysub.example'
  async function client() {
    const store = createPreviewStore(),
      network = { offline: false, loseReply: false }
    let snapshot
    const transport = (server, tokens) =>
      createTransport(server, tokens, async (url, init) => {
        if (network.offline) throw new Error('offline')
        const response = await mf.dispatchFetch(url, init)
        if (network.loseReply && url.endsWith('/push')) {
          network.loseReply = false
          throw new Error('response lost')
        }
        return response
      })
    const local = await createLocal(
      store,
      { load: async () => null, save: async () => {} },
      () => {},
      transport,
      {
        synced: (s) => {
          snapshot = s
        },
      },
    )
    await local.connect(await local.test(base, 'test', 'local-test-only'))
    return { local, store, network, snapshot: () => snapshot }
  }
  const web = await client(),
    phone = await client()
  const api = createTransport(base, web.snapshot().tokens, (url, init) => mf.dispatchFetch(url, init))
  const created = await api.request('/api/subscriptions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'VPS', next_renewal_date: '2026-11-22', remind_days_before: '1,0' }),
  })
  await phone.local.sync()
  const previous = phone.snapshot()
  await api.request('/api/subscriptions/' + created.id + '/renew', {
    method: 'POST', body: JSON.stringify({ mode: 'due' }),
  })
  const caps = await api.capabilities()
  assert.equal(caps.epoch, previous.epoch)
  assert.ok(caps.cursor > previous.cursor)
  await phone.local.sync()
  const sub = phone.store.state.subscriptions[0]
  assert.equal(sub.next_renewal_date, '2026-12-22')
  phone.network.offline = true
  await phone.local.request('put', '/api/subscriptions/' + sub.id, {
    name: 'VPS offline',
  })
  await assert.rejects(phone.local.sync(), /offline/)
  phone.network.offline = false
  phone.network.loseReply = true
  await assert.rejects(phone.local.sync(), /response lost/)
  const afterWrite = await api.capabilities()
  await phone.local.sync()
  await phone.local.sync()
  await web.local.sync()
  const webRows = await api.request('/api/subscriptions')
  assert.equal(webRows.length, 1)
  assert.equal(webRows[0].id, created.id)
  assert.equal(webRows[0].name, 'VPS offline')
  assert.equal(web.store.state.subscriptions.length, 1)
  assert.equal(web.store.state.subscriptions[0].name, 'VPS offline')
  assert.equal((await api.capabilities()).cursor, afterWrite.cursor)
  assert.equal(Object.keys(phone.local.status.conflicts).length, 0)
  // The published APK may omit the billing anchor introduced in the fork's v2.1.
  const record = Object.values(web.local.status.records).find(r => r.kind === 'subscriptions')
  const legacyData = { ...record.data }
  assert.equal(legacyData.billing_anchor_day, 22)
  delete legacyData.billing_anchor_day
  const legacy = await api.push({
    epoch: caps.epoch, device_id: 'legacy-apk',
    operations: [{ op_id: 'edit', id: record.id, kind: record.kind,
      base_version: record.version, data: legacyData }],
  })
  assert.equal(legacy.results[0].record.data.billing_anchor_day, 22)
  const preflight = await mf.dispatchFetch(base + '/api/sync/v1/push', {
    method: 'OPTIONS',
    headers: { Origin: 'https://localhost' },
  })
  assert.equal(
    preflight.headers.get('Access-Control-Allow-Origin'),
    'https://localhost',
  )
  const calls = [],
    env = {
      DB: db,
      TOKEN_SECRET: options.bindings.TOKEN_SECRET,
      TELEGRAM_BOT_TOKEN: 'test',
      TELEGRAM_CHAT_ID: 'chat',
      RESEND_API_KEY: 'test',
      EMAIL_FROM: 'sender@example.com',
      EMAIL_TO: 'recipient@example.com',
    }
  let emailFails = true
  const mock = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) })
    if (url.includes('resend') && emailFails) {
      emailFails = false
      return new Response(null, { status: 503 })
    }
    return Response.json({ ok: true })
  }
  const when = Date.parse('2026-12-21T01:00:00Z')
  await assert.rejects(remind(env, when, mock), /email/)
  await db.prepare("UPDATE deliveries SET lease=0 WHERE state='pending'").run()
  await remind(env, when, mock)
  await remind(env, when, mock)
  assert.equal(calls.filter((c) => c.url.includes('telegram')).length, 1)
  assert.equal(calls.filter((c) => c.url.includes('resend')).length, 2)
  assert.match(
    calls.find((c) => c.body.text).body.text,
    /VPS offline.*2026-12-22/,
  )
  const status = await api.request('/api/worker/notifications')
  assert.equal(status.deliveries.length, 2)
  assert.ok(status.deliveries.every(row => row.state === 'sent'))
  const prefs = await api.request('/api/worker/settings')
  const updated = await api.request('/api/worker/settings', {
    method: 'PUT', body: JSON.stringify({ ...prefs, theme: 'forest', locale: 'en', monthly_budget: 500 }),
  })
  assert.equal(updated.monthly_budget, 500)
  assert.equal((await api.request('/api/auth/me')).theme, 'forest')
  await phone.local.sync()
  assert.equal(phone.store.state.user.monthly_budget, 500)
  const log = await api.request('/api/logs')
  assert.ok(log.some(row => row.action === 'subscriptions.update' && row.created_at))
  assert.deepEqual(await api.request('/api/logs?after=' + log.at(-1).id), [])
  for (const path of ['/api/worker/settings', '/api/worker/notifications', '/api/logs'])
    assert.equal((await mf.dispatchFetch(base + path)).status, 401)

  const call=(path,method,body)=>api.request(path,{method,body:body===undefined?undefined:JSON.stringify(body)})
  const exported=await api.request('/api/backup/export')
  assert.equal(exported.subscriptions.length,1)
  assert.equal((await call('/api/backup/import','POST',{data:exported})).imported,0)
  const notifications=await api.request('/api/notifications/logs')
  assert.equal(notifications[0].days_before,'1')
  assert.ok(notifications[0].sent_at)
  const cfg=Object.fromEntries('telegram feishu qq bark email pushplus serverchan wecom dingtalk discord slack ntfy gotify webhook'.split(' ').map(k=>[k,{enabled:false}]))
  cfg.telegram={enabled:true,bot_token:'mock-secret-for-config',chat_id:'id'}
  await call('/api/notifications/config','PUT',{config:cfg})
  assert.deepEqual((await api.request('/api/notifications/config')).config,cfg)
  assert.ok(!(await db.prepare('SELECT channels FROM profile').first()).channels.includes(cfg.telegram.bot_token))
  const verifyBot = () => api.request('/api/notifications/telegram/me')
  assert.equal((await verifyBot()).result.username, 'example_bot')
  const sent = await call('/api/notifications/test', 'POST', { channel: 'telegram', config: cfg.telegram })
  assert.equal(sent.result.message_id, 1)
  redirectTelegram = true
  await assert.rejects(verifyBot, /302/)
  assert.deepEqual(telegramRequests, [
    '/botmock-secret-for-config/getMe',
    '/botmock-secret-for-config/sendMessage',
    '/botmock-secret-for-config/getMe',
  ])
  await call('/api/me','PATCH',{notify_settings:{quiet_start:'22:00',quiet_end:'06:00',digest_enabled:true,digest_weekday:1}})
  const cal=await api.request('/api/calendar/token')
  assert.match(await (await mf.dispatchFetch(base+cal.path)).text(),/BEGIN:VEVENT/)
  await api.request('/api/calendar/token?reset=true')
  assert.equal((await mf.dispatchFetch(base+cal.path)).status,404)
  await call('/api/me/account','PATCH',{username:'changed',email:'me@example.com'})
  assert.equal((await api.request('/api/auth/me')).username,'changed')
  const pat=await call('/api/me/tokens','POST',{name:'read test'})
  const asToken=(path)=>mf.dispatchFetch(base+path,{headers:{Authorization:'Bearer '+pat.token}})
  assert.equal((await asToken('/api/subscriptions')).status,200)
  assert.equal((await asToken('/api/me/tokens')).status,401)
  await call('/api/me/tokens/'+(await api.request('/api/me/tokens'))[0].id,'DELETE')
  assert.equal((await asToken('/api/subscriptions')).status,401)
  const secret=await call('/api/me/2fa/setup','POST',{password:'local-test-only'})
  assert.match(secret.secret,/^[A-Z2-7]{32}$/)
  const bits=Array.from(secret.secret,ch=>'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(ch).toString(2).padStart(5,'0')).join('')
  const raw=Uint8Array.from(bits.match(/.{8}/g),b=>parseInt(b,2))
  const k=await crypto.subtle.importKey('raw',raw,{name:'HMAC',hash:'SHA-1'},false,['sign'])
  const ctr=new DataView(new ArrayBuffer(8))
  ctr.setBigUint64(0,BigInt(Math.floor(Date.now()/30000)))
  const signed=new Uint8Array(await crypto.subtle.sign('HMAC',k,ctr))
  const code=String((new DataView(signed.buffer).getUint32(signed[19]&15)&0x7fffffff)%1000000).padStart(6,'0')
  const session=await call('/api/me/2fa/enable','POST',{password:'local-test-only',code})
  const login=(password,otp='')=>mf.dispatchFetch(base+'/api/auth/login',{method:'POST',body:new URLSearchParams({username:'changed',password,otp})})
  assert.equal((await login('local-test-only')).status,401)
  assert.equal((await login('local-test-only',code)).status,200)
  const changed=await mf.dispatchFetch(base+'/api/me/password',{method:'POST',headers:{Authorization:'Bearer '+session.access_token},body:JSON.stringify({old_password:'local-test-only',new_password:'another-local-password'})})
  assert.equal(changed.status,200)
  assert.equal((await login('another-local-password',code)).status,200)

  // Existing installations may already have sent a digest before the user
  // enables the due-day reminder on another subscription.
  const day = '2026-11-21'
  const scanTime = Date.parse(day + 'T14:00:00Z')
  const subscription = (name, due, days) => JSON.stringify({
    name, next_renewal_date: due, remind_days_before: days, billing_type: 'recurring', is_active: true,
  })
  const saveSub = (id, version, data) => db.prepare(
    "INSERT INTO changes(id,kind,version,data) VALUES (?,'subscriptions',?,?)",
  ).bind(id, version, data).run()
  await saveSub('prime', 1, subscription('Prime Video', '2026-11-26', '5'))
  await saveSub('viu', 1, subscription('Viu', day, '7,6,5,4,3,2,1'))
  await db.prepare("INSERT INTO deliveries(day,channel,state,lease,body) VALUES (?,'telegram-0','sent',0,?)")
    .bind(day, 'EasySub 续费提醒 · ' + day + '\nPrime Video · 2026-11-26 · 还有 5 天').run()
  const delivered = []
  const capture = async (url, init) => {
    delivered.push(JSON.parse(init.body).text)
    return Response.json({ ok: true })
  }
  await remind(env, scanTime, capture)
  assert.deepEqual(delivered, [])
  await saveSub('viu', 2, subscription('Viu', day, '7,6,5,4,3,2,1,0'))
  await Promise.all([remind(env, scanTime, capture), remind(env, scanTime, capture)])
  await remind(env, scanTime, capture)
  assert.deepEqual(delivered, ['EasySub 续费提醒 · ' + day + '\nViu · 2026-11-21 · 今天到期'])

})

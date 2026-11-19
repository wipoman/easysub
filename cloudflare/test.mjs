import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import * as runtime from 'miniflare'
import { createTransport } from '../frontend/src/sync/transport.js'
import { createLocal } from '../frontend/src/sync/local.js'
import { createPreviewStore } from '../frontend/src/android-preview/store.js'
import { remind } from './reminders.js'

test('original web/Android sync clients, lost response replay, and renewal delivery', async (t) => {
  const options = {
    modulesRoot: '..',
    modules: [
      'worker.js',
      'auth.js',
      'sync.js',
      'reminders.js',
      '../frontend/src/android-preview/reminder-schedule.js',
    ].map((path) => ({ type: 'ESModule', path })),
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
  for (const path of ['0001_sync.sql', '0002_defaults.sql']) {
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
  const created = await web.local.request('post', '/api/subscriptions', {
    name: 'VPS',
    next_renewal_date: '2026-11-22',
    remind_days_before: '1,0',
  })
  await web.local.sync()
  await phone.local.sync()
  const previous = phone.snapshot()
  await web.local.request(
    'post',
    '/api/subscriptions/' + created.id + '/renew',
    { mode: 'due' },
  )
  await web.local.sync()
  const api = createTransport(base, previous.tokens, (url, init) =>
    mf.dispatchFetch(url, init),
  )
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
})

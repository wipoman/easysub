import { config,deliver } from './channels.js'
import { parseReminderDays } from '../frontend/src/android-preview/reminder-schedule.js'
// Delivery bodies are immutable once queued so retries keep the same payload.
async function enqueueNewReminders(db, day, channel, events) {
  while (events.length) {
    const { results } = await db.prepare(
      "SELECT channel, body, item_keys FROM deliveries WHERE day=? AND channel GLOB ? ORDER BY channel",
    ).bind(day, channel + '-*').all()
    const seen = new Set()
    const legacyLines = new Map()
    let next = 0
    for (const row of results) {
      next = Math.max(next, Number(row.channel.slice(channel.length + 1)) + 1)
      if (row.item_keys) {
        for (const key of JSON.parse(row.item_keys)) seen.add(key)
      } else {
        // Pre-upgrade digests stored only their displayed reminder lines.
        for (const line of row.body.split('\n').slice(1)) {
          legacyLines.set(line, (legacyLines.get(line) || 0) + 1)
        }
      }
    }
    let body = 'EasySub 续费提醒 · ' + day
    const keys = []
    let hasMore = false
    for (const { key, line } of events) {
      if (seen.has(key)) continue
      const count = legacyLines.get(line) || 0
      if (count) {
        legacyLines.set(line, count - 1)
        continue
      }
      if (body.length + 1 + line.length > 3500) {
        hasMore = true
        break
      }
      body += '\n' + line
      keys.push(key)
    }
    if (!keys.length) return
    // Claim the next slot first. If a concurrent scan wins, read its keys
    // before allocating another slot. Never replace a queued or sent digest.
    const insert = await db.prepare(
      "INSERT OR IGNORE INTO deliveries(day,channel,state,lease,body,item_keys) VALUES (?,?,'pending',0,?,?)",
    ).bind(day, channel + '-' + next, body, JSON.stringify(keys)).run()
    if (insert.meta.changes && !hasMore) return
  }
}
export async function remind(env, time, send = fetch) {
  const day = new Date(time + 8 * 3600000).toISOString().slice(0, 10)
  const { results } = await env.DB.prepare(
    "SELECT id,data FROM current_records WHERE kind='subscriptions' AND deleted=0 ORDER BY id",
  ).all()
  const events = []
  for (const { id, data } of results) {
    const sub = JSON.parse(data)
    const days =
      (Date.parse(sub.next_renewal_date) - Date.parse(day)) / 86400000
    if (
      sub.is_active &&
      sub.billing_type === 'recurring' &&
      parseReminderDays(sub.remind_days_before).includes(days)
    )
      events.push({
        key: id + '/' + sub.next_renewal_date,
        line: String(sub.name).slice(0, 140) +
          ' · ' +
          sub.next_renewal_date +
          ' · ' +
          (days === 0 ? '今天到期' : '还有 ' + days + ' 天'),
      })
  }
  const cfg=await config(env)
  const channels=Object.keys(cfg).filter(k=>cfg[k]?.enabled)
  const {data:pref}=await env.DB.prepare("SELECT data FROM current_records WHERE kind='preferences' AND deleted=0").first()
  const settings=JSON.parse(pref).notify_settings || {}
  const localTime=new Date(time+8*3600000)
  const hhmm=localTime.toISOString().slice(11,16)
  const {quiet_start:start,quiet_end:end}=settings
  const quiet=start && end && (start<end ? hhmm>=start && hhmm<end : start>end && (hhmm>=start || hhmm<end))
  if(settings.digest_enabled && (localTime.getUTCDay()+6)%7===settings.digest_weekday) {
    const upcoming=results.map(r=>JSON.parse(r.data)).filter(s=>s.is_active && s.billing_type==='recurring' && s.next_renewal_date>=day &&
      (Date.parse(s.next_renewal_date)-Date.parse(day))/86400000<7)
    events.push({ key: 'weekly', line: '每周汇总 · 未来七天有 '+upcoming.length+' 项到期' })
  }
  for (const channel of channels) await enqueueNewReminders(env.DB, day, channel, events)
  const jobs = await env.DB.prepare(
    "SELECT * FROM deliveries WHERE day=? AND state!='sent' AND lease<=? ORDER BY channel LIMIT 12",
  )
    .bind(day, Date.now())
    .all()
  const failures = []
  for (const job of jobs.results) {
    const channel=job.channel.split('-')[0]
    if(!cfg[channel]?.enabled || quiet && !/今天到期|还有 1 天/.test(job.body)) continue
    const lease = Date.now() + 120000
    const lock = await env.DB.prepare(
      "UPDATE deliveries SET lease=? WHERE day=? AND channel=? AND state!='sent' AND lease<=?",
    )
      .bind(lease, day, job.channel, Date.now())
      .run()
    if (!lock.meta.changes) continue
    try {
      await deliver(channel,cfg[channel],env,job.body,send,'easysub-'+day+'-'+job.channel)
      await env.DB.prepare(
        "UPDATE deliveries SET state='sent',attempted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),error=NULL WHERE day=? AND channel=? AND lease=?",
      )
        .bind(day, job.channel, lease)
        .run()
    } catch (error) {
      const detail=error.detail || '渠道投递失败'
      await env.DB.prepare("UPDATE deliveries SET attempted_at=?,error=? WHERE day=? AND channel=? AND lease=?")
        .bind(new Date().toISOString(), detail, day,job.channel,lease).run()
      failures.push(job.channel)
    }
  }
  if (failures.length) throw new Error('提醒投递未确认：' + failures.join(', '))
}

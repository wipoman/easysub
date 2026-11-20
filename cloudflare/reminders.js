// One digest per channel and Beijing calendar day. Persist the original text for
// stable retries (including Resend's idempotency key) if a provider times out.
import { config,deliver } from './channels.js'
import { parseReminderDays } from '../frontend/src/android-preview/reminder-schedule.js'
export async function remind(env, time, send = fetch) {
  const day = new Date(time + 8 * 3600000).toISOString().slice(0, 10)
  const { results } = await env.DB.prepare(
    "SELECT data FROM current_records WHERE kind='subscriptions' AND deleted=0 ORDER BY id",
  ).all()
  const lines = []
  for (const { data } of results) {
    const sub = JSON.parse(data)
    const days =
      (Date.parse(sub.next_renewal_date) - Date.parse(day)) / 86400000
    if (
      sub.is_active &&
      sub.billing_type === 'recurring' &&
      parseReminderDays(sub.remind_days_before).includes(days)
    )
      lines.push(
        String(sub.name).slice(0, 140) +
          ' · ' +
          sub.next_renewal_date +
          ' · ' +
          (days === 0 ? '今天到期' : '还有 ' + days + ' 天'),
      )
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
    lines.push('每周汇总 · 未来七天有 '+upcoming.length+' 项到期')
  }
  // Bound each message by Telegram's text limit, even with exceptionally long lists.
  const parts = []
  for (const line of lines) {
    if (!parts.length || parts.at(-1).length + line.length > 3500)
      parts.push('EasySub 续费提醒 · ' + day)
    parts[parts.length - 1] += '\n' + line
  }
  for (const channel of channels) {
    if (parts.length)
      await env.DB.batch(
        parts.map((body, i) =>
          env.DB.prepare(
            'INSERT OR IGNORE INTO deliveries(day,channel,state,lease,body) VALUES (?,?,?,0,?)',
          ).bind(day, channel + '-' + i, 'pending', body),
        ),
      )
  }
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

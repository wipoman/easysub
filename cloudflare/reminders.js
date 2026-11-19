// One digest per channel and Beijing calendar day. Persist the original text for
// stable retries (including Resend's idempotency key) if a provider times out.
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
  const channels = []
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) channels.push('telegram')
  if (env.RESEND_API_KEY && env.EMAIL_FROM && env.EMAIL_TO)
    channels.push('email')
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
    const lease = Date.now() + 120000
    const lock = await env.DB.prepare(
      "UPDATE deliveries SET lease=? WHERE day=? AND channel=? AND state!='sent' AND lease<=?",
    )
      .bind(lease, day, job.channel, Date.now())
      .run()
    if (!lock.meta.changes) continue
    try {
      const telegram = job.channel.startsWith('telegram-')
      const url = telegram
        ? 'https://api.telegram.org/bot' +
          env.TELEGRAM_BOT_TOKEN +
          '/sendMessage'
        : 'https://api.resend.com/emails'
      const headers = { 'Content-Type': 'application/json' }
      if (!telegram)
        Object.assign(headers, {
          Authorization: 'Bearer ' + env.RESEND_API_KEY,
          'Idempotency-Key': 'easysub-' + day + '-' + job.channel,
        })
      const body = telegram
        ? { chat_id: env.TELEGRAM_CHAT_ID, text: job.body }
        : {
            from: env.EMAIL_FROM,
            to: [env.EMAIL_TO],
            subject: 'EasySub 续费提醒 ' + day,
            text: job.body,
          }
      const res = await send(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(12000),
      })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      await env.DB.prepare(
        "UPDATE deliveries SET state='sent' WHERE day=? AND channel=? AND lease=?",
      )
        .bind(day, job.channel, lease)
        .run()
    } catch {
      failures.push(job.channel)
    }
  }
  if (failures.length) throw new Error('提醒投递未确认：' + failures.join(', '))
}

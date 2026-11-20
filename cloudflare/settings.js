import { Failure } from './sync.js'
import { notificationApi } from './channels.js'
import { remind } from './reminders.js'
export async function calendar(env,token) {
  if(!/^[0-9a-f-]{36}$/.test(token) || !await env.DB.prepare('SELECT 1 FROM profile WHERE calendar=?').bind(token).first()) throw new Failure(404,'订阅地址无效')
  const {results}=await env.DB.prepare("SELECT id,data FROM current_records WHERE kind='subscriptions' AND deleted=0").all()
  const lines=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//EasySub//Renewals//ZH','CALSCALE:GREGORIAN']
  for(const r of results) {
    const s=JSON.parse(r.data)
    if(!s.is_active || s.show_in_calendar===false || !/^\d{4}-\d{2}-\d{2}$/.test(s.next_renewal_date)) continue
    const title=String(s.name).replaceAll('\\','\\\\').replace(/\r\n|\r|\n/g,'\\n').replace(/([,;])/g,'\\$1')
    lines.push('BEGIN:VEVENT','UID:'+r.id+'@easysub','DTSTAMP:'+new Date().toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,''),'DTSTART;VALUE=DATE:'+s.next_renewal_date.replaceAll('-',''),'SUMMARY:'+title,'END:VEVENT')
  }
  return new Response([...lines,'END:VCALENDAR',''].join('\r\n'),{headers:{'Content-Type':'text/calendar; charset=utf-8'}})
}
export async function settingsApi(req,env,url) {
  const path=url.pathname,m=req.method,db=env.DB
  if(path==='/api/notifications/run-scan' && m==='POST') { await remind(env,Date.now());return {ok:true} }
  if(path==='/api/notifications/logs' && m==='GET') {
    const rows=await db.prepare('SELECT * FROM deliveries ORDER BY day DESC,attempted_at DESC,channel LIMIT 100').all()
    return rows.results.map(r=>({id:r.day+r.channel,channel:r.channel.split('-')[0],sent_at:r.attempted_at || r.day,
      status:r.state==='sent'?'sent':r.error?'failed':'pending',message:(r.error?r.error+'\n':'')+r.body,
      days_before:[...new Set([...r.body.matchAll(/今天到期|还有 (\d+) 天/g)].map(m=>m[1]||'0'))].join('、') || '—'}))
  }
  if(path.startsWith('/api/notifications/')) return notificationApi(req,env,path)
  if(path==='/api/calendar/token' && m==='GET') {
    await db.prepare('UPDATE profile SET calendar=? WHERE id=1 AND (calendar IS NULL OR ?=1)').bind(crypto.randomUUID(),Number(url.searchParams.get('reset')==='true')).run()
    return {path:'/api/calendar/feed/'+(await db.prepare('SELECT calendar FROM profile').first()).calendar+'.ics'}
  }
  if(path==='/api/system/info' && m==='GET') return {version:'2.1.0 Workers',db_configured:true,server_time:new Date().toISOString(),timezone:'Asia/Shanghai',reminder_scan_time:'09:00',
    your_subscriptions:(await db.prepare("SELECT COUNT(*) n FROM current_records WHERE kind='subscriptions' AND deleted=0").first()).n}
  if(path==='/api/system/version-check' && m==='GET') {
    try {
      const r=await fetch('https://api.github.com/repos/suyijun8182/easysub/releases/latest',{headers:{'User-Agent':'EasySub-Worker'},cf:{cacheTtl:3600},signal:AbortSignal.timeout(5000)})
      if(!r.ok) throw Error()
      const release=await r.json(),latest=release.tag_name.replace(/^v/,'')
      const [major,minor,patch]=latest.split('.').map(Number)
      return {latest,update_available:major>2 || major===2 && (minor>1 || minor===1 && patch>0),release_url:release.html_url}
    } catch {return {error:true}}
  }
  if(path==='/api/currencies/rates/refresh' && m==='POST') {
    const r=await fetch('https://open.er-api.com/v6/latest/CNY',{signal:AbortSignal.timeout(8000)})
    if(!r.ok) throw new Failure(502,'汇率服务未响应')
    const x=await r.json()
    if(x.result!=='success'||x.rates?.CNY!==1) throw new Failure(502,'汇率数据无效')
    await db.prepare('UPDATE profile SET rates=?,rate_time=? WHERE id=1').bind(JSON.stringify(x.rates),new Date(x.time_last_update_unix*1000).toISOString()).run()
    return {ok:true}
  }
  throw new Failure(404,'接口不存在')
}

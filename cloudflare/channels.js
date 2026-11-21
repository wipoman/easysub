import { Failure } from './sync.js'
import { seal, unseal } from './profile.js'
const names = 'telegram feishu qq bark email pushplus serverchan wecom dingtalk discord slack ntfy gotify webhook'.split(' ')
const split = value => String(value || '').split(/[,，\n]/).map(x=>x.trim()).filter(Boolean)
const enc = encodeURIComponent
const utf = new TextEncoder()
async function mac(secret,text) {
  const k=await crypto.subtle.importKey('raw',utf.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC',k,utf.encode(text)))
}
export async function config(env) {
  const row=await env.DB.prepare('SELECT channels FROM profile WHERE id=1').first()
  if(row.channels) return JSON.parse(await unseal(env,row.channels))
  return {telegram:{enabled:!!(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID),chat_id:env.TELEGRAM_CHAT_ID || ''},
    email:{enabled:!!(env.RESEND_API_KEY && env.EMAIL_FROM && env.EMAIL_TO),from:env.EMAIL_FROM || '',to:env.EMAIL_TO || ''}}
}
function requireValue(value,key) {
  if(!value || Array.isArray(value) && !value.length) throw new Failure(422,'缺少 '+key)
  return value
}
export async function deliver(channel,c,env,text,send=fetch,job='',action='') {
  const subject=text.split('\n')[0], list=split
  async function call(url,body,headers={},timeout=12000) {
    let target
    try { target=new URL(url) } catch { throw new Failure(422,'请填写完整的 HTTPS 地址') }
    if(target.protocol!=='https:' || target.username || target.password) throw new Failure(422,'需要 HTTPS 地址')
    let response
    try {
      response=await send(target.href,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...headers},
        body:body===undefined?undefined:JSON.stringify(body),redirect:'manual',signal:AbortSignal.timeout(timeout)})
    } catch { throw new Failure(502,'渠道连接失败或超时') }
    if(!response.ok) throw new Failure(502,'渠道返回 HTTP '+response.status)
    const data=await response.json().catch(()=>({}))
    if(data.ok===false || Number(data.errcode || 0)!==0 || data.code!=null && ![0,200].includes(Number(data.code)))
      throw new Failure(502,'渠道拒绝请求，错误码 '+(data.errcode || data.code || data.error_code || 'unknown'))
    return data
  }
  switch(channel) {
    case 'telegram': {
      const token=requireValue(c.bot_token || env.TELEGRAM_BOT_TOKEN,'Bot Token')
      const base=c.api_base && c.bot_token ? c.api_base.replace(/\/$/,'') : 'https://api.telegram.org'
      const endpoint=(base.includes('://')?base:'https://'+base)+'/bot'+token+'/'
      if(action) return call(endpoint+action)
      return call(endpoint+'sendMessage',{chat_id:requireValue(c.chat_id,'Chat ID'),text})
    }
    case 'email': return call('https://api.resend.com/emails',{from:requireValue(c.from,'发件人'),to:requireValue(list(c.to),'收件人'),subject,text},
      {Authorization:'Bearer '+requireValue(c.password || env.RESEND_API_KEY,'Resend API Key'),...(job?{'Idempotency-Key':job}:{})})
    case 'discord': return call(c.url,{content:text.slice(0,1900)})
    case 'slack': return call(c.url,{text})
    case 'pushplus': return call('https://www.pushplus.plus/send',{token:c.token,title:subject,content:text,template:'txt',topic:c.topic,channel:c.channel})
    case 'serverchan': return call('https://sctapi.ftqq.com/'+enc(requireValue(c.sendkey,'SendKey'))+'.send',{title:subject,desp:text})
    case 'ntfy': return call(c.server || 'https://ntfy.sh',{topic:requireValue(c.topic,'Topic'),title:subject,message:text},c.token?{Authorization:'Bearer '+c.token}:{})
    case 'gotify': return call(c.server.replace(/\/$/,'')+'/message',{title:subject,message:text,priority:Number(c.priority || 5)},{'X-Gotify-Key':requireValue(c.token,'Token')})
    case 'bark':
      for(const url of requireValue(c.urls?.filter(Boolean),'Bark URL')) await call(url,{title:subject,body:text,level:c.level,group:c.group,icon:c.icon})
      break
    case 'dingtalk': {
      const url=new URL(c.url)
      if(c.secret) {
        const time=Date.now()
        url.searchParams.set('timestamp',time)
        url.searchParams.set('sign',btoa(String.fromCharCode(...await mac(c.secret,time+'\n'+c.secret))))
      }
      return call(url,{msgtype:'text',text:{content:text}})
    }
    case 'wecom': {
      if(c.mode!=='app') return call(c.url,{msgtype:'text',text:{content:text}})
      const base=(c.proxy_base || 'https://qyapi.weixin.qq.com').replace(/\/$/,'')
      const auth=await call(base+'/cgi-bin/gettoken?'+new URLSearchParams({corpid:c.corp_id,corpsecret:c.secret}))
      const token=enc(requireValue(auth.access_token,'企业微信 access token'))
      if(action) {
        const a=await call(base+'/cgi-bin/agent/get?agentid='+enc(c.agent_id)+'&access_token='+token)
        return {agent:{name:a.name,agentid:a.agentid,users:a.allow_userinfos?.user?.length || 0,parties:a.allow_partys?.partyid?.length || 0,tags:a.allow_tags?.tagid?.length || 0}}
      }
      const card=c.msg_type==='textcard'
      return call(base+'/cgi-bin/message/send?access_token='+token,{touser:c.to_user,toparty:c.to_party,totag:c.to_tag,agentid:c.agent_id,msgtype:card?'textcard':'text',
        ...(card?{textcard:{title:subject,description:text,url:c.card_url}}:{text:{content:text}})})
    }
    case 'qq': {
      const groups=list(c.group_ids), users=list(c.user_ids)
      requireValue([...groups,...users],'QQ OpenID')
      const auth=await call('https://bots.qq.com/app/getAppAccessToken',{appId:c.app_id,clientSecret:c.app_secret})
      const headers={Authorization:'QQBot '+requireValue(auth.access_token,'QQ access token')}
      for(const [kind,ids] of [['groups',groups],['users',users]]) for(const id of ids)
        await call('https://api.sgroup.qq.com/v2/'+kind+'/'+enc(id)+'/messages',{content:text,msg_type:0},headers)
      break
    }
    case 'feishu': {
      const base='https://open.feishu.cn/open-apis'
      const auth=await call(base+'/auth/v3/tenant_access_token/internal',{app_id:c.app_id,app_secret:c.app_secret})
      for(const id of requireValue(list(c.chat_ids),'飞书 Chat ID')) await call(base+'/im/v1/messages?receive_id_type=chat_id',
        {receive_id:id,msg_type:'text',content:JSON.stringify({text})},{Authorization:'Bearer '+requireValue(auth.tenant_access_token,'飞书 access token')})
      break
    }
    case 'webhook': {
      const body={subject,text,event:job?'reminder':'test',timestamp:Math.floor(Date.now()/1000)}
      if(c.template) body.text=c.template.replace(/{{\s*(\w+)\s*}}/g,(m,k)=>Object.hasOwn(body,k)?body[k]:m)
      const headers=Object.fromEntries((c.headers || []).filter(h=>h.key).map(h=>[h.key,h.value]))
      if(c.secret) headers['X-EasySub-Signature']=Array.from(await mac(c.secret,JSON.stringify(body)),x=>x.toString(16).padStart(2,'0')).join('')
      for(const url of requireValue(c.urls?.filter(Boolean),'Webhook URL')) {
        for(let i=0;;i++) {
          try { await call(url,body,headers,Math.min(30000,Math.max(1000, Number(c.timeout_ms)||5000)));break }
          catch(e) {if(i>=Math.min(3,Number(c.max_retries)||0)) throw e}
        }
      }
      break
    }
    default: throw new Failure(422,'未知通知渠道')
  }
  return {ok:true}
}
export async function notificationApi(req,env,path) {
  const current=await config(env)
  if(path.endsWith('/config')) {
    if(req.method==='GET') return {config:current}
    if(req.method==='PUT') {
      const {config:next}=await req.json()
      if(!next || names.some(k=>typeof next[k]?.enabled!=='boolean') || JSON.stringify(next).length>64000) throw new Failure(422,'渠道配置不完整')
      await env.DB.prepare('UPDATE profile SET channels=? WHERE id=1').bind(await seal(env,JSON.stringify(Object.fromEntries(names.map(k=>[k,next[k]]))))).run()
      return {ok:true}
    }
  }
  if(path.endsWith('/test') && req.method==='POST') {
    const data=await req.json()
    return deliver(data.channel,data.config,env,'EasySub 测试通知')
  }
  if(path.endsWith('/wecom/check') && req.method==='POST') return deliver('wecom',{...(await req.json()).config,mode:'app'},env,'',fetch,'','check')
  if(req.method==='GET' && ['/api/notifications/telegram/me','/api/notifications/telegram/updates'].includes(path))
    return deliver('telegram',current.telegram || {},env,'',fetch,'',path.endsWith('/me')?'getMe':'getUpdates')
  throw new Failure(404,'接口不存在')
}

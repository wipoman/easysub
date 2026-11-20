import { hash, tokens } from './auth.js'
import { Failure } from './sync.js'
const enc = new TextEncoder()
const hex = a => Array.from(new Uint8Array(a), x => x.toString(16).padStart(2,'0')).join('')
const bytes = s => Uint8Array.from(s.match(/../g), x => parseInt(x,16))
async function cipher(env) {
  const raw = await crypto.subtle.digest('SHA-256',enc.encode('easysub-settings/' + env.TOKEN_SECRET))
  return crypto.subtle.importKey('raw',raw,'AES-GCM',false,['encrypt','decrypt'])
}
export async function seal(env,value) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  return hex(iv) + hex(await crypto.subtle.encrypt({name:'AES-GCM',iv},await cipher(env),enc.encode(value)))
}
export async function unseal(env,value) {
  return new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes(value.slice(0,24))},await cipher(env),bytes(value.slice(24))))
}
export async function sessionEnv(env) {
  const profile = await env.DB.prepare('SELECT username,email,password,epoch,otp,pending FROM profile WHERE id=1').first()
  return {...env, profile, ADMIN_USERNAME:profile.username || env.ADMIN_USERNAME, sessionKey:env.TOKEN_SECRET + profile.epoch}
}
async function derive(password,salt) {
  const key = await crypto.subtle.importKey('raw',enc.encode(password),'PBKDF2',false,['deriveBits'])
  return hex(await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:bytes(salt),iterations:100000},key,256))
}
export async function passwordOK(env,password) {
  if (typeof password !== 'string' || !password || password.length>1024) return false
  if (!env.profile.password) return await hash(password) === await hash(env.ADMIN_PASSWORD)
  const [salt,digest] = env.profile.password.split('.')
  return await derive(password,salt) === digest
}
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
function base32(raw) {
  const bits = [...raw].map(x=>x.toString(2).padStart(8,'0')).join('')
  return bits.match(/.{5}/g).map(x=>alphabet[parseInt(x,2)]).join('')
}
export async function otpOK(env,encrypted,code) {
  if (!encrypted || !/^\d{6}$/.test(code)) return false
  const key = await crypto.subtle.importKey('raw',bytes(await unseal(env,encrypted)),{name:'HMAC',hash:'SHA-1'},false,['sign'])
  for(let delta=-1;delta<=1;delta++) {
    const counter = new DataView(new ArrayBuffer(8))
    counter.setBigUint64(0,BigInt(Math.floor(Date.now()/30000)+delta))
    const sig=new Uint8Array(await crypto.subtle.sign('HMAC',key,counter)), offset=sig[19]&15
    const number=new DataView(sig.buffer).getUint32(offset)&0x7fffffff
    if(String(number%1000000).padStart(6,'0')===code) return true
  }
  return false
}
export async function account(req,env,path) {
  const db=env.DB, method=req.method
  if(path==='/api/me/tokens' && method==='GET') return (await db.prepare('SELECT id,name,created_at,last_used_at FROM api_keys ORDER BY id DESC').all()).results
  if(/^\/api\/me\/tokens\/\d+$/.test(path) && method==='DELETE') {
    await db.prepare('DELETE FROM api_keys WHERE id=?').bind(Number(path.split('/').pop())).run()
    return {ok:true}
  }
  const data=await req.json()
  if(path==='/api/me/tokens' && method==='POST') {
    if(!data.name?.trim() || data.name.length>128) throw new Failure(422,'请输入 Token 名称')
    const token='es_'+hex(crypto.getRandomValues(new Uint8Array(32)))
    await db.prepare('INSERT INTO api_keys(name,digest,created_at) VALUES(?,?,?)').bind(data.name,await hash(token),new Date().toISOString()).run()
    return {token}
  }
  if(path==='/api/me/account' && method==='PATCH') {
    if(!data.username?.trim() || data.username.length>128 || typeof data.email!=='string' || data.email.length>254) throw new Failure(422,'账号信息无效')
    await db.prepare('UPDATE profile SET username=?,email=? WHERE id=1').bind(data.username.trim(),data.email).run()
    return {ok:true}
  }
  if(method!=='POST') throw new Failure(405,'请求方法不支持')
  if(!await passwordOK(env,data.old_password || data.password)) throw new Failure(403,'原密码错误')
  const epoch=crypto.randomUUID()
  if(path==='/api/me/password') {
    if(typeof data.new_password!=='string'||data.new_password.length<8||data.new_password.length>1024) throw new Failure(422,'新密码须为 8 至 1024 个字符')
    const salt=hex(crypto.getRandomValues(new Uint8Array(16)))
    await db.prepare('UPDATE profile SET password=?,epoch=? WHERE id=1').bind(salt+'.'+await derive(data.new_password,salt),epoch).run()
  } else if(path==='/api/me/2fa/setup' && !env.profile.otp) {
    const raw=crypto.getRandomValues(new Uint8Array(20))
    await db.prepare('UPDATE profile SET pending=? WHERE id=1 AND otp IS NULL').bind(await seal(env,hex(raw))).run()
    return {secret:base32(raw)}
  } else if(path==='/api/me/2fa/enable' && !env.profile.otp && await otpOK(env,env.profile.pending,data.code)) {
    const res=await db.prepare('UPDATE profile SET otp=pending,pending=NULL,epoch=? WHERE id=1 AND pending=? AND otp IS NULL').bind(epoch,env.profile.pending).run()
    if(!res.meta.changes) throw new Failure(409,'设置已变更')
  } else if(path==='/api/me/2fa/disable' && await otpOK(env,env.profile.otp,data.code)) {
    await db.prepare('UPDATE profile SET otp=NULL,pending=NULL,epoch=? WHERE id=1').bind(epoch).run()
  } else throw new Failure(422,'验证码或设置状态无效')
  return tokens({...env,sessionKey:env.TOKEN_SECRET+epoch})
}

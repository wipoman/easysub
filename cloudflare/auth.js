const encoder = new TextEncoder()
export async function hash(value) {
  const bytes = await crypto.subtle.digest('SHA-256', encoder.encode(value))
  return Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('')
}
function hex(bytes) {
  return Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('')
}
async function key(env) {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(env.TOKEN_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
}
async function issue(type, seconds, env) {
  const payload = [
    type,
    Math.floor(Date.now() / 1000) + seconds,
    crypto.randomUUID(),
  ].join('.')
  return (
    payload +
    '.' +
    hex(
      await crypto.subtle.sign('HMAC', await key(env), encoder.encode(payload)),
    )
  )
}
export async function tokens(env) {
  return {
    access_token: await issue('access', 3600, env),
    refresh_token: await issue('refresh', 30 * 86400, env),
    token_type: 'bearer',
  }
}
export async function valid(token, type, env) {
  if (typeof token !== 'string' || token.length > 256) return false
  const parts = token.split('.')
  if (
    parts.length !== 4 ||
    parts[0] !== type ||
    !/^\d+$/.test(parts[1]) ||
    Number(parts[1]) <= Date.now() / 1000 ||
    !/^[a-f0-9]{64}$/.test(parts[3])
  )
    return false
  const signature = Uint8Array.from(parts.pop().match(/../g), (b) =>
    parseInt(b, 16),
  )
  return crypto.subtle.verify(
    'HMAC',
    await key(env),
    signature,
    encoder.encode(parts.join('.')),
  )
}

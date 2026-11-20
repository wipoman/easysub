import { hash } from './auth.js'
export class Failure extends Error {
  constructor(status, detail) {
    super(typeof detail === 'string' ? detail : detail.message)
    this.status = status
    this.detail = detail
  }
}
const kinds = new Set([
  'subscriptions',
  'categories',
  'payment-methods',
  'bundles',
  'currencies',
  'preferences',
])
const identifier = /^[A-Za-z0-9_-]{1,64}$/
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i
function envelope(row) {
  if (!row || row.id == null) return null
  return {
    id: row.id,
    kind: row.kind,
    version: row.version,
    seq: row.seq,
    readonly: !!row.readonly,
    deleted: !!row.deleted,
    data: JSON.parse(row.data),
  }
}
async function head(db) {
  return db
    .prepare(
      'SELECT epoch,(SELECT COALESCE(MAX(seq),0) FROM changes) cursor FROM installation',
    )
    .first()
}
function checkEpoch(state, epoch) {
  if (state.epoch !== epoch)
    throw new Failure(409, {
      code: 'RESET_REQUIRED',
      message: '资料库已更换，请重新确认同步',
    })
}
export async function capabilities(db, username) {
  const current = await head(db)
  const { results } = await db
    .prepare(
      'SELECT kind,count(*) n FROM current_records WHERE deleted=0 AND readonly=0 GROUP BY kind',
    )
    .all()
  return {
    ...current,
    protocol: 1,
    account_id: 1,
    username,
    max_batch: 8,
    exchange_base: 'CNY',
    currency_codes: 'globally-unique',
    conflicts: 'preserve-both',
    counts: Object.fromEntries(results.map((r) => [r.kind, r.n])),
  }
}
export async function changes(db, params) {
  const state = await head(db)
  checkEpoch(state, params.get('epoch') ?? state.epoch)
  const cursor = Number(params.get('cursor') || 0),
    limit = Number(params.get('limit') || 100)
  if (
    !Number.isSafeInteger(cursor) ||
    cursor < 0 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 500
  )
    throw new Failure(422, '游标或分页无效')
  if (cursor > state.cursor) checkEpoch(state, null)
  const { results } = await db
    .prepare(
      'SELECT * FROM changes WHERE seq>? AND seq<=? ORDER BY seq LIMIT ?',
    )
    .bind(cursor, state.cursor, limit + 1)
    .all()
  const page = results.slice(0, limit)
  return {
    epoch: state.epoch,
    next_cursor: page.at(-1)?.seq ?? cursor,
    has_more: results.length > limit,
    changes: page.map(envelope),
  }
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, stable(value[k])]),
    )
  return value
}
// All three statements run in one D1 transaction. The immutable receipt references
// the precise version seen on first submission, even if newer edits have since arrived.
async function apply(db, device, op) {
  const data = JSON.stringify(op.data ?? {}),
    digest = await hash(JSON.stringify(stable(op)))
  if (
    !identifier.test(op.op_id) ||
    !uuid.test(op.id) ||
    !Number.isSafeInteger(op.base_version) ||
    op.base_version < 0 ||
    data.length > 131072
  )
    throw new Failure(422, '无效的同步操作')
  if (
    !kinds.has(op.kind) ||
    !op.data ||
    Array.isArray(op.data) ||
    typeof op.data !== 'object'
  )
    return { op_id: op.op_id, status: 'rejected', code: 'INVALID_DATA' }
  const insert = db
    .prepare(
      `INSERT INTO changes(id,kind,version,deleted,data,device,op,created_at)
    SELECT ?1,?2,?3+1,?4,
      CASE WHEN ?2='subscriptions' AND json_extract(?5,'$.cycle') IN ('month','year')
        AND json_type(?5,'$.billing_anchor_day') IS NULL AND prior.anchor IS NOT NULL
        THEN json_set(?5,'$.billing_anchor_day',prior.anchor) ELSE ?5 END,?6,?7,strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM (SELECT (SELECT json_extract(data,'$.billing_anchor_day') FROM changes
                  WHERE id=?1 AND version=?3) AS anchor) AS prior
    WHERE NOT EXISTS(SELECT 1 FROM receipts WHERE device=?6 AND op=?7)
    AND ((?3=0 AND ?2!='preferences' AND NOT EXISTS(SELECT 1 FROM changes WHERE id=?1))
      OR EXISTS(SELECT 1 FROM current_records WHERE id=?1 AND kind=?2 AND version=?3 AND readonly=0 AND (deleted=0 OR ?4=1 OR ?8=1)))
    AND NOT (?2='currencies' AND ?4=0 AND EXISTS(SELECT 1 FROM current_records WHERE kind='currencies' AND deleted=0 AND id!=?1 AND upper(json_extract(data,'$.code'))=upper(json_extract(?5,'$.code'))))
    AND NOT (?2='preferences' AND ?4=1)`,
    )
    .bind(
      op.id,
      op.kind,
      op.base_version,
      Number(!!op.deleted),
      data,
      device,
      op.op_id,
      Number(!!op.restore),
    )
  const receipt = db
    .prepare(
      `INSERT INTO receipts SELECT ?1,?2,?3,
    CASE WHEN EXISTS(SELECT 1 FROM changes WHERE device=?1 AND op=?2) THEN 'applied' ELSE 'conflict' END,
    (SELECT seq FROM changes WHERE id=?4 ORDER BY version DESC LIMIT 1)
    ON CONFLICT(device,op) DO NOTHING`,
    )
    .bind(device, op.op_id, digest, op.id)
  const lookup = db
    .prepare(
      'SELECT r.status,r.digest,c.* FROM receipts r LEFT JOIN changes c ON c.seq=r.seq WHERE r.device=? AND r.op=?',
    )
    .bind(device, op.op_id)
  const result = await db.batch([insert, receipt, lookup])
  const row = result[2].results[0]
  if (row.digest !== digest)
    return { op_id: op.op_id, status: 'rejected', code: 'OP_ID_REUSED' }
  return {
    op_id: op.op_id,
    status: row.status,
    [row.status === 'applied' ? 'record' : 'server']: envelope(row),
  }
}
export async function push(db, input) {
  const state = await head(db)
  checkEpoch(state, input.epoch)
  if (
    !identifier.test(input.device_id) ||
    !Array.isArray(input.operations) ||
    input.operations.length > 100
  )
    throw new Failure(422, '无效的同步批次')
  const results = []
  for (const op of input.operations)
    results.push(await apply(db, input.device_id, op))
  return { epoch: state.epoch, results, cursor: (await head(db)).cursor }
}

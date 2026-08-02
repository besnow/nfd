const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const { webcrypto } = require('node:crypto')

function createHarness () {
  const values = new Map()
  const lastWrites = new Map()
  const puts = []
  const telegram = { forwards: 0, sent: [], deleted: [], copies: [], mapFailures: 0 }
  const liveMessages = new Set()
  let nextMessageId = 500
  let forwardOk = true
  let forceDeleteFailure = false

  function enforceWriteLimit (key) {
    const now = Date.now()
    if (now - (lastWrites.get(key) || 0) < 1000) {
      const error = new Error(`429: KV key ${key} written more than once per second`)
      error.status = 429
      throw error
    }
    lastWrites.set(key, now)
  }

  const nfd = {
    async get (key, options) {
      const value = values.get(key)
      if (value === undefined) return null
      if (options?.type === 'json' && typeof value === 'string') return JSON.parse(value)
      return value
    },
    async put (key, value, options) {
      enforceWriteLimit(key)
      puts.push({ key, value, options, at: Date.now() })
      if (key.startsWith('msg-map-') && telegram.mapFailures-- > 0) throw new Error('KV unavailable')
      values.set(key, value)
    },
    async delete (key) {
      enforceWriteLimit(key)
      values.delete(key)
    }
  }

  async function fetch (url, request = {}) {
    if (!url.includes('api.telegram.org')) return { text: async () => '' }
    const method = new URL(url).pathname.split('/').pop()
    const body = request.body ? JSON.parse(request.body) : {}
    if (method === 'sendMessage') {
      const messageId = ++nextMessageId
      telegram.sent.push({ ...body, messageId })
      liveMessages.add(messageId)
      return { json: async () => ({ ok: true, result: { message_id: messageId } }) }
    }
    if (method === 'deleteMessage') {
      telegram.deleted.push(body)
      if (forceDeleteFailure || !liveMessages.has(body.message_id)) return { json: async () => ({ ok: false }) }
      liveMessages.delete(body.message_id)
      return { json: async () => ({ ok: true }) }
    }
    if (method === 'forwardMessage') {
      telegram.forwards++
      return { json: async () => forwardOk ? { ok: true, result: { message_id: 700 + telegram.forwards } } : { ok: false } }
    }
    if (method === 'copyMessage') {
      telegram.copies.push(body)
      return { json: async () => ({ ok: true }) }
    }
    return { json: async () => ({ ok: true }) }
  }

  const source = fs.readFileSync('worker.js', 'utf8') + `
    ;globalThis.testApi = { createCaptcha, savePendingMessage, ensureCaptcha,
      onCallbackQuery, onMessage, forwardGuestMessage, handleAdminMessage }
  `
  const context = {
    ENV_BOT_TOKEN: 'token', ENV_BOT_SECRET: 'secret', ENV_ADMIN_UID: 1,
    addEventListener () {}, crypto: webcrypto, URL, URLSearchParams, Response,
    console, Date, Math, fetch, nfd, setTimeout
  }
  vm.createContext(context)
  vm.runInContext(source, context)
  return {
    api: context.testApi, values, puts, telegram, liveMessages,
    setForwardOk (value) { forwardOk = value },
    setDeleteFailure (value) { forceDeleteFailure = value }
  }
}

function installActiveChallenge (h, uid = '2', messageId = 99) {
  const state = h.api.createCaptcha(uid, Number(uid), 0, messageId)
  state.writtenAt = Date.now() - 1200
  h.values.set(`captcha-${uid}`, JSON.stringify(state))
  h.liveMessages.add(messageId)
  return state
}

function callback (uid, state, optionId = state.correctOptionId) {
  return {
    id: `callback-${Math.random()}`,
    from: { id: Number(uid) },
    data: `captcha:${state.id}:${optionId}`,
    message: { message_id: state.messageId, chat: { id: state.chatId, type: 'private' } }
  }
}

async function testOrdinaryAndStartFlows () {
  const ordinary = createHarness()
  await ordinary.api.onMessage({ from: { id: 2 }, chat: { id: 2, type: 'private' }, message_id: 10, text: 'question' })
  const state = JSON.parse(ordinary.values.get('captcha-2'))
  const pending = JSON.parse(ordinary.values.get('pending-message-2'))
  assert.equal(pending.messageId, 10)
  assert.equal(state.expiresAt, pending.expiresAt)
  await ordinary.api.onCallbackQuery(callback('2', state))
  assert.equal(ordinary.telegram.forwards, 1)

  const start = createHarness()
  await start.api.onMessage({ from: { id: 3 }, chat: { id: 3, type: 'private' }, message_id: 20, text: '/start' })
  assert.equal(start.values.has('pending-message-3'), false)
  assert.ok(start.values.has('captcha-3'))
}

async function testDelayedDuplicateCorrectAnswer () {
  const h = createHarness()
  const state = installActiveChallenge(h)
  h.values.set('pending-message-2', JSON.stringify({ chatId: 2, messageId: 10, expiresAt: state.expiresAt }))
  await h.api.onCallbackQuery(callback('2', state))
  await h.api.onCallbackQuery(callback('2', state))
  assert.equal(h.telegram.forwards, 1)
  assert.equal(h.telegram.deleted.length, 2)
  assert.ok(h.values.has(`captcha-claim-${state.id}`))
}

async function testConcurrentWrongAnswers () {
  const h = createHarness()
  const state = installActiveChallenge(h)
  const wrong = state.options.find(option => option.id !== state.correctOptionId).id
  await Promise.all([
    h.api.onCallbackQuery(callback('2', state, wrong)),
    h.api.onCallbackQuery(callback('2', state, wrong))
  ])
  const replacement = JSON.parse(h.values.get('captcha-2'))
  const captchaSends = h.telegram.sent.filter(message => message.reply_markup)
  assert.equal(replacement.failures, 1)
  assert.equal(captchaSends.length, 1)
  assert.equal(replacement.messageId, captchaSends[0].messageId)
  assert.equal(replacement.expiresAt, state.expiresAt)
}

async function testDeleteFailureAndClaimRecovery () {
  const failed = createHarness()
  const state = installActiveChallenge(failed)
  failed.setDeleteFailure(true)
  await failed.api.onCallbackQuery(callback('2', state))
  assert.equal(failed.telegram.forwards, 0)
  assert.equal(failed.values.has('verified-2'), false)
  assert.equal(failed.values.has(`captcha-claim-${state.id}`), false)

  const recovery = createHarness()
  const stale = installActiveChallenge(recovery)
  stale.writtenAt = Date.now() - 40000
  recovery.values.set('captcha-2', JSON.stringify(stale))
  recovery.values.set(`captcha-claim-${stale.id}`, JSON.stringify({ userId: '2', claimedAt: Date.now() - 31000 }))
  await recovery.api.ensureCaptcha({ from: { id: 2 }, chat: { id: 2, type: 'private' } })
  const replacement = JSON.parse(recovery.values.get('captcha-2'))
  assert.notEqual(replacement.id, stale.id)
  assert.equal(replacement.expiresAt, stale.expiresAt)
}

async function testPendingPreservation () {
  const h = createHarness()
  const [first, second] = await Promise.all([
    h.api.savePendingMessage({ from: { id: 2 }, chat: { id: 2 }, message_id: 10 }),
    h.api.savePendingMessage({ from: { id: 2 }, chat: { id: 2 }, message_id: 11 })
  ])
  assert.equal(first.messageId, 10)
  assert.equal(second.messageId, 10)
  assert.equal(JSON.parse(h.values.get('pending-message-2')).messageId, 10)
  assert.equal(h.puts.filter(item => item.key === 'pending-message-2').length, 1)
}

async function testForwardMappingResultsAndAdminReply () {
  const retry = createHarness()
  retry.telegram.mapFailures = 1
  const retryResult = await retry.api.forwardGuestMessage(2, 10)
  assert.equal(retryResult.forwarded, true)
  assert.equal(retryResult.mapped, true)
  assert.equal(retry.puts.filter(item => item.key === 'msg-map-701').length, 2)

  const exhausted = createHarness()
  exhausted.telegram.mapFailures = 3
  const exhaustedResult = await exhausted.api.forwardGuestMessage(3, 11)
  assert.equal(exhaustedResult.forwarded, true)
  assert.equal(exhaustedResult.mapped, false)

  const failed = createHarness()
  failed.setForwardOk(false)
  assert.equal((await failed.api.forwardGuestMessage(4, 12)).forwarded, false)

  retry.values.set('msg-map-700', '2')
  await retry.api.handleAdminMessage({ from: { id: 1 }, chat: { id: 1 }, message_id: 30, text: 'reply', reply_to_message: { message_id: 700, chat: { id: 1 } } })
  assert.equal(retry.telegram.copies.at(-1).chat_id, 2)
}

async function testForwardResultMessages () {
  const mappingFailed = createHarness()
  const mappedState = installActiveChallenge(mappingFailed)
  mappingFailed.values.set('pending-message-2', JSON.stringify({ chatId: 2, messageId: 10, expiresAt: mappedState.expiresAt }))
  mappingFailed.telegram.mapFailures = 3
  await mappingFailed.api.onCallbackQuery(callback('2', mappedState))
  assert.match(mappingFailed.telegram.sent.at(-1).text, /您的消息已发送/)

  const forwardFailed = createHarness()
  const failedState = installActiveChallenge(forwardFailed)
  forwardFailed.values.set('pending-message-2', JSON.stringify({ chatId: 2, messageId: 10, expiresAt: failedState.expiresAt }))
  forwardFailed.setForwardOk(false)
  await forwardFailed.api.onCallbackQuery(callback('2', failedState))
  assert.match(forwardFailed.telegram.sent.at(-1).text, /请重新发送一次/)
}

async function main () {
  await testOrdinaryAndStartFlows()
  await testDelayedDuplicateCorrectAnswer()
  await testConcurrentWrongAnswers()
  await testDeleteFailureAndClaimRecovery()
  await testPendingPreservation()
  await testForwardMappingResultsAndAdminReply()
  await testForwardResultMessages()
  console.log('worker tests passed with KV one-write-per-second enforcement')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})

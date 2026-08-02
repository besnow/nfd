const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const { webcrypto } = require('node:crypto')

function createHarness () {
  const values = new Map()
  const puts = []
  const telegram = { forwards: 0, edits: [], copies: [], mapFailures: 0 }
  let claimedMessage = false
  let forwardOk = true

  const nfd = {
    async get (key, options) {
      const value = values.get(key)
      if (value === undefined) return null
      if (options?.type === 'json' && typeof value === 'string') return JSON.parse(value)
      return value
    },
    async put (key, value, options) {
      puts.push({ key, value, options })
      if (key.startsWith('msg-map-') && telegram.mapFailures-- > 0) throw new Error('KV unavailable')
      values.set(key, value)
    },
    async delete (key) { values.delete(key) }
  }

  async function fetch (url, request = {}) {
    if (!url.includes('api.telegram.org')) return { text: async () => '' }
    const method = new URL(url).pathname.split('/').pop()
    const body = request.body ? JSON.parse(request.body) : {}
    if (method === 'forwardMessage') {
      telegram.forwards++
      return { json: async () => forwardOk ? { ok: true, result: { message_id: 700 + telegram.forwards } } : { ok: false } }
    }
    if (method === 'editMessageText') {
      telegram.edits.push(body)
      if (body.text === '⏳ 验证处理中，请稍候……') {
        if (claimedMessage) return { json: async () => ({ ok: false }) }
        claimedMessage = true
      }
      return { json: async () => ({ ok: true, result: { message_id: body.message_id } }) }
    }
    if (method === 'copyMessage') {
      telegram.copies.push(body)
      return { json: async () => ({ ok: true }) }
    }
    return { json: async () => ({ ok: true, result: { message_id: 500 } }) }
  }

  const source = fs.readFileSync('worker.js', 'utf8') + `
    ;globalThis.testApi = { createCaptcha, savePendingMessage, ensureCaptcha,
      onCallbackQuery, onMessage, forwardGuestMessage, handleAdminMessage }
  `
  const context = {
    ENV_BOT_TOKEN: 'token', ENV_BOT_SECRET: 'secret', ENV_ADMIN_UID: 1,
    addEventListener () {}, crypto: webcrypto, URL, URLSearchParams, Response,
    console, Date, Math, fetch, nfd
  }
  vm.createContext(context)
  vm.runInContext(source, context)
  return {
    api: context.testApi, values, puts, telegram,
    setForwardOk (value) { forwardOk = value }
  }
}

function callback (uid, state) {
  return {
    id: `callback-${Math.random()}`,
    from: { id: Number(uid) },
    data: `captcha:${state.id}:${state.correctOptionId}`,
    message: { message_id: state.messageId, chat: { id: state.chatId, type: 'private' } }
  }
}

async function testConcurrentCorrectAnswer () {
  const h = createHarness()
  const state = h.api.createCaptcha('2', 2, 0, 99, 'active')
  h.values.set('captcha-2', JSON.stringify(state))
  h.values.set('pending-message-2', JSON.stringify({ chatId: 2, messageId: 10 }))
  await Promise.all([h.api.onCallbackQuery(callback('2', state)), h.api.onCallbackQuery(callback('2', state))])
  assert.equal(h.telegram.forwards, 1, 'concurrent correct callbacks must forward once')
  assert.equal(JSON.parse(h.values.get('verified-2')), true)
  assert.equal(h.values.has('pending-message-2'), false)
}

async function testOrdinaryUserFlow () {
  const h = createHarness()
  await h.api.onMessage({ from: { id: 2 }, chat: { id: 2, type: 'private' }, message_id: 10, text: 'question' })
  const state = JSON.parse(h.values.get('captcha-2'))
  await h.api.onCallbackQuery(callback('2', state))
  assert.equal(h.telegram.forwards, 1)
  assert.equal(h.values.has('pending-message-2'), false)
}

async function testForwardMappingResults () {
  const retry = createHarness()
  retry.telegram.mapFailures = 1
  assert.deepEqual(
    JSON.parse(JSON.stringify(await retry.api.forwardGuestMessage(2, 10))),
    { forwarded: true, mapped: true, adminMessageId: 701 }
  )
  assert.equal(retry.puts.filter(item => item.key === 'msg-map-701').length, 2)

  const exhausted = createHarness()
  exhausted.telegram.mapFailures = 3
  const exhaustedResult = await exhausted.api.forwardGuestMessage(3, 11)
  assert.equal(exhaustedResult.forwarded, true)
  assert.equal(exhaustedResult.mapped, false)

  const failed = createHarness()
  failed.setForwardOk(false)
  assert.equal((await failed.api.forwardGuestMessage(4, 12)).forwarded, false)
}

async function testUserMessagesAndFinalText () {
  const mapped = createHarness()
  const state = mapped.api.createCaptcha('2', 2, 0, 99, 'active')
  mapped.values.set('captcha-2', JSON.stringify(state))
  mapped.values.set('pending-message-2', JSON.stringify({ chatId: 2, messageId: 10 }))
  mapped.telegram.mapFailures = 3
  await mapped.api.onCallbackQuery(callback('2', state))
  assert.match(mapped.telegram.edits.at(-1).text, /您的消息已发送/)

  const failed = createHarness()
  const failedState = failed.api.createCaptcha('3', 3, 0, 100, 'active')
  failed.values.set('captcha-3', JSON.stringify(failedState))
  failed.values.set('pending-message-3', JSON.stringify({ chatId: 3, messageId: 11 }))
  failed.setForwardOk(false)
  await failed.api.onCallbackQuery(callback('3', failedState))
  assert.match(failed.telegram.edits.at(-1).text, /请重新发送一次/)
}

async function testExpiryPendingAndAdminReply () {
  const h = createHarness()
  await Promise.all([
    h.api.savePendingMessage({ from: { id: 2 }, chat: { id: 2 }, message_id: 10 }),
    h.api.savePendingMessage({ from: { id: 2 }, chat: { id: 2 }, message_id: 11 })
  ])
  assert.equal(JSON.parse(h.values.get('pending-message-2')).messageId, 10)

  const state = h.api.createCaptcha('2', 2, 0, 99, 'active')
  const wrongId = state.options.find(option => option.id !== state.correctOptionId).id
  h.values.set('captcha-2', JSON.stringify(state))
  await h.api.onCallbackQuery({ ...callback('2', state), data: `captcha:${state.id}:${wrongId}` })
  assert.equal(JSON.parse(h.values.get('captcha-2')).expiresAt, state.expiresAt)
  const replacementPut = h.puts.filter(item => item.key === 'captcha-2').at(-1)
  assert.ok(replacementPut.options.expirationTtl <= 600)

  const startOnly = createHarness()
  await startOnly.api.onMessage({ from: { id: 4 }, chat: { id: 4, type: 'private' }, message_id: 20, text: '/start' })
  assert.equal(startOnly.values.has('pending-message-4'), false)

  h.values.set('msg-map-700', '2')
  await h.api.handleAdminMessage({ from: { id: 1 }, chat: { id: 1 }, message_id: 30, text: 'reply', reply_to_message: { message_id: 700, chat: { id: 1 } } })
  assert.equal(h.telegram.copies.at(-1).chat_id, 2)
}

async function main () {
  await testOrdinaryUserFlow()
  await testConcurrentCorrectAnswer()
  await testForwardMappingResults()
  await testUserMessagesAndFinalText()
  await testExpiryPendingAndAdminReply()
  console.log('worker tests passed')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})

const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const { webcrypto } = require('node:crypto')

function createHarness () {
  const visitorStartMessage = fs.readFileSync('data/startMessage.md', 'utf8')
  const adminStartMessage = fs.readFileSync('data/adminMessage.md', 'utf8')
  const values = new Map()
  const lastWrites = new Map()
  const puts = []
  const telegram = {
    forwards: 0,
    sent: [],
    deleted: [],
    copies: [],
    mapFailures: 0,
    captchaFailures: 0,
    claimFailures: 0,
    verifiedFailures: 0,
    forwardRequests: []
  }
  const liveMessages = new Set()
  let nextMessageId = 500
  let forwardOk = true
  let copyOk = true
  let clockOffset = 0
  const now = () => Date.now() + clockOffset
  class HarnessDate extends Date {
    static now () { return now() }
  }
  let forceDeleteFailure = false

  function enforceWriteLimit (key) {
    const writtenAt = now()
    if (writtenAt - (lastWrites.get(key) || 0) < 1000) {
      const error = new Error(`429: KV key ${key} written more than once per second`)
      error.status = 429
      throw error
    }
    lastWrites.set(key, writtenAt)
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
      puts.push({ key, value, options, at: now() })
      if (key.startsWith('verified-') && telegram.verifiedFailures-- > 0) throw new Error('KV unavailable')
      if (key.startsWith('msg-map-') && telegram.mapFailures-- > 0) throw new Error('KV unavailable')
      if (key.startsWith('captcha-claim-') && telegram.claimFailures-- > 0) throw new Error('KV unavailable')
      if (key.startsWith('captcha-') && !key.startsWith('captcha-claim-') && telegram.captchaFailures-- > 0) {
        throw new Error('KV unavailable')
      }
      values.set(key, value)
      if (key.startsWith('verified-') && telegram.afterVerifiedWrite) telegram.afterVerifiedWrite()
    },
    async delete (key) {
      enforceWriteLimit(key)
      if (telegram.failDeleteKey === key) throw new Error('KV unavailable')
      values.delete(key)
    }
  }

  async function fetch (url, request = {}) {
    if (url.endsWith('/data/startMessage.md')) return { text: async () => visitorStartMessage }
    if (url.endsWith('/data/adminMessage.md')) return { text: async () => adminStartMessage }
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
      if (telegram.afterDelete) telegram.afterDelete()
      return { json: async () => ({ ok: true }) }
    }
    if (method === 'forwardMessage') {
      telegram.forwards++
      telegram.forwardRequests.push(body)
      return { json: async () => forwardOk ? { ok: true, result: { message_id: 700 + telegram.forwards } } : { ok: false } }
    }
    if (method === 'copyMessage') {
      telegram.copies.push(body)
      return { json: async () => ({ ok: copyOk }) }
    }
    return { json: async () => ({ ok: true }) }
  }

  const source = fs.readFileSync('worker.js', 'utf8') + `
    ;globalThis.testApi = {
      createCaptcha, savePendingMessage, ensureCaptcha, onCallbackQuery, onMessage,
      forwardGuestMessage, handleAdminMessage,
      getMessageFingerprint
    }
  `
  const context = {
    ENV_BOT_TOKEN: 'token',
    ENV_BOT_SECRET: 'secret',
    ENV_ADMIN_UID: 1,
    addEventListener () {},
    crypto: webcrypto,
    TextEncoder,
    Uint8Array,
    URL,
    URLSearchParams,
    Response,
    console,
    Date: HarnessDate,
    Math,
    fetch,
    nfd,
    setTimeout
  }
  vm.createContext(context)
  vm.runInContext(source, context)
  return {
    api: context.testApi,
    values,
    puts,
    telegram,
    liveMessages,
    now,
    advance (milliseconds) { clockOffset += milliseconds },
    setCopyOk (value) { copyOk = value },
    setForwardOk (value) { forwardOk = value },
    setDeleteFailure (value) { forceDeleteFailure = value }
  }
}

function installActiveChallenge (h, uid = '2', messageId = 99, round = 1) {
  const state = h.api.createCaptcha(uid, Number(uid), 0, messageId, null, round)
  state.writtenAt = h.now() - 1200
  h.values.set(`captcha-${uid}`, JSON.stringify(state))
  h.liveMessages.add(messageId)
  return state
}

function callback (uid, state, optionId = state.correctOptionId) {
  return {
    id: `callback-${Math.random()}`,
    from: { id: Number(uid) },
    data: `captcha:${state.id}:${optionId}`,
    message: {
      message_id: state.messageId,
      chat: { id: state.chatId, type: 'private' }
    }
  }
}

function suspiciousMessage (uid = 2, messageId = 10) {
  return {
    from: { id: uid },
    chat: { id: uid, type: 'private' },
    message_id: messageId,
    text: '请访问 https://example.com 联系我们'
  }
}

function visitorMessage (text = '你好', uid = 2, messageId = 10) {
  return {
    from: { id: uid },
    chat: { id: uid, type: 'private' },
    message_id: messageId,
    text
  }
}

function installVerification (h, uid = '2', overrides = {}) {
  const session = {
    version: 3,
    verifiedAt: h.now(),
    expiresAt: h.now() + 24 * 60 * 60 * 1000,
    ...overrides
  }
  h.values.set(`verified-${uid}`, JSON.stringify(session))
  return session
}

async function testFirstContactGate () {
  for (const content of [
    { text: '你好' },
    { text: '在吗' },
    { photo: [{ file_id: 'photo' }] },
    { video: { file_id: 'video' } },
    { document: { file_id: 'document' } },
    { sticker: { file_id: 'sticker' } },
    { text: '请访问 https://example.com 联系我们' }
  ]) {
    const h = createHarness()
    const firstMessage = { ...visitorMessage(), ...content }
    if (!('text' in content)) delete firstMessage.text
    await h.api.onMessage(firstMessage)
    const challenge = JSON.parse(h.values.get('captcha-2'))
    assert.equal(h.telegram.forwards, 0)
    assert.equal(challenge.round, 1)
    assert.equal(challenge.options.length, 6)
    const keyboard = h.telegram.sent.find(message => message.reply_markup).reply_markup.inline_keyboard
    assert.deepEqual(Array.from(keyboard, row => row.length), [3, 3])
    assert.equal(JSON.parse(h.values.get('pending-message-2')).messageId, 10)

    // A harmless follow-up must not escape an outstanding challenge, and it
    // must not replace the first message that will be delivered after success.
    await h.api.onMessage(visitorMessage('只是打个招呼', 2, 11))
    await h.api.onMessage(visitorMessage('再补充一条', 2, 12))
    assert.equal(h.telegram.forwards, 0)
    assert.equal(JSON.parse(h.values.get('pending-message-2')).messageId, 10)
    assert.equal(h.telegram.sent.filter(message => message.reply_markup).length, 1)
  }

  const trusted = createHarness()
  trusted.values.set('trusted-4', JSON.stringify({ trustedAt: trusted.now() }))
  await trusted.api.onMessage(suspiciousMessage(4, 12))
  assert.equal(trusted.telegram.forwards, 1)
  assert.equal(trusted.values.has('captcha-4'), false)

  const start = createHarness()
  await start.api.onMessage(visitorMessage('/start', 5, 20))
  assert.equal(start.telegram.forwards, 0)
  assert.equal(start.values.has('captcha-5'), false)
  assert.equal(start.values.has('verified-5'), false)
  assert.equal(start.telegram.sent.at(-1).text, fs.readFileSync('data/startMessage.md', 'utf8'))
  assert.doesNotMatch(start.telegram.sent.at(-1).text, /管理员使用|管理命令|\/block|信任名单/)
  await start.api.onMessage(visitorMessage('你好', 5, 21))
  assert.equal(start.telegram.forwards, 0)
  assert.ok(start.values.has('captcha-5'))

  const adminStart = createHarness()
  await adminStart.api.onMessage(visitorMessage('/start', 1, 21))
  assert.equal(adminStart.telegram.forwards, 0)
  assert.equal(adminStart.telegram.sent.at(-1).text, fs.readFileSync('data/adminMessage.md', 'utf8'))
  assert.match(adminStart.telegram.sent.at(-1).text, /管理员|\/block|信任名单/)
}

async function testTwoRoundCaptcha () {
  const h = createHarness()
  await h.api.onMessage(visitorMessage())
  const first = JSON.parse(h.values.get('captcha-2'))

  await h.api.onCallbackQuery(callback('2', first))
  const second = JSON.parse(h.values.get('captcha-2'))
  assert.equal(second.round, 2)
  assert.equal(h.telegram.forwards, 0)
  assert.equal(h.values.has('verified-2'), false)

  await h.api.onCallbackQuery(callback('2', second))
  const verified = JSON.parse(h.values.get('verified-2'))
  assert.equal(verified.version, 3)
  assert.equal(verified.expiresAt - verified.verifiedAt, 24 * 60 * 60 * 1000)
  assert.equal(h.puts.find(item => item.key === 'verified-2').options.expirationTtl, 86400)
  assert.equal(h.values.has('trusted-2'), false)
  assert.equal(JSON.parse(h.values.get('captcha-2')).status, 'completed')
  assert.equal(JSON.parse(h.values.get('pending-message-2')).status, 'completed')
  assert.equal(h.telegram.forwards, 1)
  assert.equal(h.telegram.forwardRequests[0].message_id, 10)
  assert.match(h.telegram.sent.at(-1).text, /验证成功/)

  const challengeCount = h.telegram.sent.filter(message => message.reply_markup).length
  await h.api.onMessage(suspiciousMessage(2, 11))
  await h.api.onMessage({ ...visitorMessage(undefined, 2, 12), photo: [{ file_id: 'photo' }] })
  assert.equal(h.telegram.forwards, 3)
  assert.equal(h.telegram.sent.filter(message => message.reply_markup).length, challengeCount)
  assert.equal(h.values.get('verified-2'), JSON.stringify(verified))
  assert.equal(h.puts.filter(item => item.key === 'verified-2').length, 1)

  await h.api.onCallbackQuery(callback('2', second))
  assert.equal(h.telegram.forwards, 3)
}

async function testVerificationExpiryAndLegacyState () {
  const h = createHarness()
  const session = installVerification(h)
  h.advance(24 * 60 * 60 * 1000 - 1000)
  await h.api.onMessage(visitorMessage('有效期最后一秒', 2, 10))
  assert.equal(h.telegram.forwards, 1)
  assert.equal(h.values.get('verified-2'), JSON.stringify(session))

  // A cached KV value can outlive its logical deadline; expiresAt is decisive.
  h.advance(1000)
  await h.api.onMessage(visitorMessage('有效期已结束', 2, 11))
  assert.equal(h.telegram.forwards, 1)
  assert.ok(h.values.has('captcha-2'))
  assert.equal(JSON.parse(h.values.get('pending-message-2')).messageId, 11)

  for (const stored of [
    { version: 2, verifiedAt: Date.now(), expiresAt: Date.now() + 60000 },
    { version: 3, verifiedAt: Date.now() - 1000, expiresAt: Date.now() - 1 },
    { version: 3 },
    true
  ]) {
    const invalid = createHarness()
    invalid.values.set('verified-2', JSON.stringify(stored))
    await invalid.api.onMessage(visitorMessage())
    assert.equal(invalid.telegram.forwards, 0)
    assert.ok(invalid.values.has('captcha-2'))
  }
}

async function testDelayedDuplicateCorrectAnswer () {
  const h = createHarness()
  const first = installActiveChallenge(h)
  h.values.set('pending-message-2', JSON.stringify({
    chatId: 2,
    messageId: 10,
    expiresAt: first.expiresAt
  }))
  await h.api.onCallbackQuery(callback('2', first))
  await h.api.onCallbackQuery(callback('2', first))
  const second = JSON.parse(h.values.get('captcha-2'))
  await h.api.onCallbackQuery(callback('2', second))
  assert.equal(h.telegram.forwards, 1)
  assert.ok(h.values.has(`captcha-claim-${first.id}`))
}

async function testWrongAnswersAndConcurrency () {
  const concurrent = createHarness()
  const state = installActiveChallenge(concurrent)
  const wrong = state.options.find(option => option.id !== state.correctOptionId).id
  await Promise.all([
    concurrent.api.onCallbackQuery(callback('2', state, wrong)),
    concurrent.api.onCallbackQuery(callback('2', state, wrong))
  ])
  const replacement = JSON.parse(concurrent.values.get('captcha-2'))
  assert.equal(replacement.failures, 1)
  assert.equal(replacement.round, 1)
  assert.equal(concurrent.telegram.sent.filter(message => message.reply_markup).length, 1)

  const blocked = createHarness()
  const first = installActiveChallenge(blocked)
  const firstWrong = first.options.find(option => option.id !== first.correctOptionId).id
  await blocked.api.onCallbackQuery(callback('2', first, firstWrong))
  const secondTry = JSON.parse(blocked.values.get('captcha-2'))
  const secondWrong = secondTry.options.find(option => option.id !== secondTry.correctOptionId).id
  await blocked.api.onCallbackQuery(callback('2', secondTry, secondWrong))
  assert.equal(blocked.values.get('captcha-block-2'), 'true')
  assert.equal(blocked.telegram.forwards, 0)
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
  recovery.values.set(
    `captcha-claim-${stale.id}`,
    JSON.stringify({ userId: '2', claimedAt: Date.now() - 31000 })
  )
  await recovery.api.ensureCaptcha({
    from: { id: 2 },
    chat: { id: 2, type: 'private' }
  })
  const replacement = JSON.parse(recovery.values.get('captcha-2'))
  assert.notEqual(replacement.id, stale.id)
  assert.equal(replacement.expiresAt, stale.expiresAt)
}

async function testCaptchaWriteFailureDeletesMessage () {
  const recovered = createHarness()
  recovered.telegram.captchaFailures = 1
  await recovered.api.onMessage(visitorMessage())
  assert.equal(recovered.telegram.forwards, 0)
  assert.equal(JSON.parse(recovered.values.get('captcha-2')).status, 'active')
  assert.equal(recovered.telegram.sent.filter(message => message.reply_markup).length, 1)
  assert.equal(recovered.telegram.deleted.length, 0)

  const h = createHarness()
  h.telegram.captchaFailures = 3
  await h.api.onMessage(suspiciousMessage())
  const captchaMessage = h.telegram.sent.find(message => message.reply_markup)
  assert.ok(captchaMessage)
  assert.equal(h.values.has('captcha-2'), false)
  assert.equal(h.liveMessages.has(captchaMessage.messageId), false)
  assert.equal(h.telegram.deleted.at(-1).message_id, captchaMessage.messageId)
}

async function testCaptchaClaimRetries () {
  const retry = createHarness()
  const state = installActiveChallenge(retry, '2', 99, 2)
  retry.values.set('pending-message-2', JSON.stringify({
    chatId: 2,
    messageId: 10,
    expiresAt: state.expiresAt
  }))
  retry.telegram.claimFailures = 2
  await retry.api.onCallbackQuery(callback('2', state))
  const retryPuts = retry.puts.filter(item => item.key === `captcha-claim-${state.id}`)
  assert.equal(retryPuts.length, 3)
  assert.ok(retryPuts[1].at - retryPuts[0].at >= 1000)
  assert.ok(retryPuts[2].at - retryPuts[1].at >= 1000)
  assert.equal(retry.telegram.forwards, 1)

  const exhausted = createHarness()
  const exhaustedState = installActiveChallenge(exhausted, '2', 99, 2)
  exhausted.values.set('pending-message-2', JSON.stringify({
    chatId: 2,
    messageId: 10,
    expiresAt: exhaustedState.expiresAt
  }))
  exhausted.telegram.claimFailures = 3
  await exhausted.api.onCallbackQuery(callback('2', exhaustedState))
  assert.equal(exhausted.values.has(`captcha-claim-${exhaustedState.id}`), false)
  assert.equal(JSON.parse(exhausted.values.get('verified-2')).version, 3)
  assert.equal(JSON.parse(exhausted.values.get('captcha-2')).status, 'completed')
  assert.equal(exhausted.telegram.forwards, 1)
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

async function testForwardMappingAndAutomaticTrust () {
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
  await retry.api.handleAdminMessage({
    from: { id: 1 },
    chat: { id: 1 },
    message_id: 30,
    text: '正常回复',
    reply_to_message: { message_id: 700, chat: { id: 1 } }
  })
  assert.equal(retry.telegram.copies.at(-1).chat_id, 2)
  assert.ok(JSON.parse(retry.values.get('trusted-2')).trustedAt)
  retry.advance(25 * 60 * 60 * 1000)
  await retry.api.onMessage(suspiciousMessage())
  assert.equal(retry.telegram.forwards, 2)
  assert.equal(retry.values.has('captcha-2'), false)

  const rejectedReply = createHarness()
  rejectedReply.values.set('msg-map-700', '2')
  rejectedReply.setCopyOk(false)
  await rejectedReply.api.handleAdminMessage({
    ...visitorMessage('正常回复', 1, 30),
    reply_to_message: { message_id: 700, chat: { id: 1 } }
  })
  assert.equal(rejectedReply.telegram.copies.length, 1)
  assert.equal(rejectedReply.values.has('trusted-2'), false)
}

async function testSpamFingerprintBlocking () {
  const h = createHarness()
  const ad = '推广投资高收益，请访问 https://spam.example.com 联系我们'
  h.values.set('msg-map-700', '2')
  h.values.set('trusted-2', JSON.stringify({ trustedAt: Date.now() }))
  installVerification(h)

  await h.api.handleAdminMessage({
    from: { id: 1 },
    chat: { id: 1 },
    message_id: 30,
    text: '/block',
    reply_to_message: { message_id: 700, chat: { id: 1 }, text: ad }
  })

  assert.equal(h.values.get('isblocked-2'), 'true')
  assert.equal(h.values.has('trusted-2'), false)
  assert.equal(h.values.has('verified-2'), false)
  const fingerprintKeys = [...h.values.keys()].filter(key => key.startsWith('spam-fingerprint-'))
  assert.equal(fingerprintKeys.length, 1)

  await h.api.onMessage({
    from: { id: 3 },
    chat: { id: 3, type: 'private' },
    message_id: 31,
    text: ad
  })
  assert.equal(h.values.get('isblocked-3'), 'true')
  assert.equal(h.telegram.forwards, 0)

  const unblocked = createHarness()
  const fingerprint = await unblocked.api.getMessageFingerprint({ text: ad })
  unblocked.values.set('msg-map-700', '2')
  unblocked.values.set('isblocked-2', 'true')
  unblocked.values.set('spam-fingerprint-' + fingerprint, 'true')
  await unblocked.api.handleAdminMessage({
    from: { id: 1 },
    chat: { id: 1 },
    message_id: 32,
    text: '/unblock',
    reply_to_message: { message_id: 700, chat: { id: 1 }, text: ad }
  })
  assert.equal(unblocked.values.get('isblocked-2'), 'false')
  assert.equal(unblocked.values.has('spam-fingerprint-' + fingerprint), false)
  assert.equal(unblocked.values.has('trusted-2'), false)
  assert.equal(unblocked.values.has('verified-2'), false)
  await unblocked.api.onMessage(visitorMessage())
  assert.equal(unblocked.telegram.forwards, 0)
  assert.ok(unblocked.values.has('captcha-2'))

  // Verification is permission to communicate, not a second content screen.
  const verified = createHarness()
  installVerification(verified)
  verified.values.set('spam-fingerprint-' + fingerprint, 'true')
  await verified.api.onMessage(visitorMessage(ad))
  assert.equal(verified.telegram.forwards, 1)
  assert.equal(verified.values.has('isblocked-2'), false)
}

async function testForwardResultMessages () {
  const mappingFailed = createHarness()
  const mappedState = installActiveChallenge(mappingFailed, '2', 99, 2)
  mappingFailed.values.set('pending-message-2', JSON.stringify({
    chatId: 2,
    messageId: 10,
    expiresAt: mappedState.expiresAt
  }))
  mappingFailed.telegram.mapFailures = 3
  await mappingFailed.api.onCallbackQuery(callback('2', mappedState))
  assert.match(mappingFailed.telegram.sent.at(-1).text, /您的消息已发送/)

  const forwardFailed = createHarness()
  const failedState = installActiveChallenge(forwardFailed, '2', 99, 2)
  forwardFailed.values.set('pending-message-2', JSON.stringify({
    chatId: 2,
    messageId: 10,
    expiresAt: failedState.expiresAt
  }))
  forwardFailed.setForwardOk(false)
  await forwardFailed.api.onCallbackQuery(callback('2', failedState))
  assert.match(forwardFailed.telegram.sent.at(-1).text, /请重新发送一次/)
}

async function testVerificationWriteFailureAndRecovery () {
  const retry = createHarness()
  const state = installActiveChallenge(retry, '2', 99, 2)
  retry.values.set('pending-message-2', JSON.stringify({
    chatId: 2, messageId: 10, expiresAt: state.expiresAt
  }))
  retry.telegram.verifiedFailures = 2
  await retry.api.onCallbackQuery(callback('2', state))
  const writes = retry.puts.filter(item => item.key === 'verified-2')
  assert.equal(writes.length, 3)
  assert.ok(writes[1].at - writes[0].at >= 1000)
  assert.ok(writes[2].at - writes[1].at >= 1000)
  assert.equal(retry.telegram.forwards, 1)
  assert.equal(JSON.parse(retry.values.get('verified-2')).version, 3)

  const failed = createHarness()
  const failedState = installActiveChallenge(failed, '2', 99, 2)
  failed.values.set('pending-message-2', JSON.stringify({
    chatId: 2, messageId: 10, status: 'active', expiresAt: failedState.expiresAt
  }))
  failed.telegram.verifiedFailures = 3
  await failed.api.onCallbackQuery(callback('2', failedState))
  assert.equal(failed.telegram.forwards, 0)
  assert.equal(failed.values.has('verified-2'), false)
  assert.equal(JSON.parse(failed.values.get('pending-message-2')).messageId, 10)
  assert.notEqual(JSON.parse(failed.values.get('pending-message-2')).status, 'completed')
  assert.equal(JSON.parse(failed.values.get('captcha-2')).status, 'completed')
  assert.doesNotMatch(failed.telegram.sent.at(-1).text, /验证成功/)

  await failed.api.onMessage(visitorMessage('重新尝试', 2, 11))
  const replacement = JSON.parse(failed.values.get('captcha-2'))
  assert.notEqual(replacement.id, failedState.id)
  assert.equal(replacement.status, 'active')
  assert.equal(failed.telegram.forwards, 0)
  assert.equal(JSON.parse(failed.values.get('pending-message-2')).messageId, 10)
  await failed.api.onCallbackQuery(callback('2', replacement))
  await failed.api.onCallbackQuery(callback('2', JSON.parse(failed.values.get('captcha-2'))))
  assert.equal(failed.telegram.forwards, 1)
  assert.equal(failed.telegram.forwardRequests[0].message_id, 10)
  assert.equal(JSON.parse(failed.values.get('verified-2')).version, 3)
}

async function testImmediateBlockAndUnblockRevokesPermissions () {
  const h = createHarness()
  const state = installActiveChallenge(h, '2', 99, 2)
  h.values.set('pending-message-2', JSON.stringify({
    chatId: 2, messageId: 10, status: 'active', expiresAt: state.expiresAt
  }))
  await h.api.onCallbackQuery(callback('2', state))
  const adminReply = {
    ...visitorMessage('收到', 1, 30),
    reply_to_message: { message_id: 701, chat: { id: 1 }, text: '你好' }
  }
  await h.api.handleAdminMessage(adminReply)
  assert.ok(h.values.has('trusted-2'))
  assert.ok(h.values.has('verified-2'))

  // Both permissions were just written. Revocation must survive KV's same-key
  // write limit instead of leaving stale access for a later /unblock.
  await h.api.handleAdminMessage({ ...adminReply, text: '/block', message_id: 31 })
  assert.equal(h.values.get('isblocked-2'), 'true')
  for (const key of ['trusted-2', 'verified-2', 'captcha-2', 'pending-message-2']) {
    assert.equal(h.values.has(key), false, key)
  }
  await h.api.onMessage(visitorMessage('被屏蔽后继续发送', 2, 12))
  assert.equal(h.telegram.forwards, 1)

  await h.api.handleAdminMessage({ ...adminReply, text: '/unblock', message_id: 32 })
  assert.equal(h.values.get('isblocked-2'), 'false')
  await h.api.onMessage(visitorMessage('解封后的新消息', 2, 13))
  assert.equal(h.telegram.forwards, 1)
  assert.equal(h.values.has('trusted-2'), false)
  assert.equal(h.values.has('verified-2'), false)
  assert.equal(JSON.parse(h.values.get('captcha-2')).status, 'active')
  assert.equal(JSON.parse(h.values.get('pending-message-2')).messageId, 13)
}

async function testInvalidPendingMessagesAreNotForwarded () {
  for (const kind of ['absent', 'expired', 'completed', 'other-chat', 'missing-message']) {
    const h = createHarness()
    const state = installActiveChallenge(h, '2', 99, 2)
    const pending = { chatId: 2, messageId: 10, status: 'active', expiresAt: state.expiresAt }
    if (kind === 'expired') pending.expiresAt = h.now() - 1
    if (kind === 'completed') pending.status = 'completed'
    if (kind === 'other-chat') pending.chatId = 3
    if (kind === 'missing-message') delete pending.messageId
    if (kind !== 'absent') h.values.set('pending-message-2', JSON.stringify(pending))
    await h.api.onCallbackQuery(callback('2', state))
    assert.equal(h.telegram.forwards, 0, kind)
    assert.equal(JSON.parse(h.values.get('verified-2')).version, 3, kind)
    assert.match(h.telegram.sent.at(-1).text, /验证成功/)
  }
}

async function testBlocksOverrideTrustAndVerification () {
  for (const key of ['isblocked-2', 'captcha-block-2', 'rate-block-2']) {
    const h = createHarness()
    installVerification(h)
    h.values.set('trusted-2', JSON.stringify({ trustedAt: h.now() }))
    h.values.set(key, 'true')
    await h.api.onMessage(visitorMessage())
    assert.equal(h.telegram.forwards, 0, key)
    assert.equal(h.telegram.sent.length, 0, key)
  }

  const blocked = createHarness()
  const state = installActiveChallenge(blocked, '2', 99, 2)
  blocked.values.set('pending-message-2', JSON.stringify({
    chatId: 2, messageId: 10, expiresAt: state.expiresAt
  }))
  // Simulate /block landing after the callback's first check. The final grant
  // must recheck the ban rather than recreate a session that /block revoked.
  blocked.telegram.afterDelete = () => blocked.values.set('isblocked-2', 'true')
  await blocked.api.onCallbackQuery(callback('2', state))
  assert.equal(blocked.telegram.forwards, 0)
  assert.equal(blocked.values.has('verified-2'), false)

  const blockedDuringGrant = createHarness()
  const grantState = installActiveChallenge(blockedDuringGrant, '2', 99, 2)
  blockedDuringGrant.values.set('pending-message-2', JSON.stringify({
    chatId: 2, messageId: 10, expiresAt: grantState.expiresAt
  }))
  blockedDuringGrant.telegram.afterVerifiedWrite = () => blockedDuringGrant.values.set('isblocked-2', 'true')
  await blockedDuringGrant.api.onCallbackQuery(callback('2', grantState))
  assert.equal(blockedDuringGrant.telegram.forwards, 0)
  for (const key of ['trusted-2', 'verified-2', 'captcha-2', 'pending-message-2']) {
    assert.equal(blockedDuringGrant.values.has(key), false, key)
  }
}

async function testUnblockRevocationFailureKeepsBan () {
  const h = createHarness()
  h.values.set('msg-map-700', '2')
  h.values.set('isblocked-2', 'true')
  h.values.set('trusted-2', JSON.stringify({ trustedAt: h.now() }))
  installVerification(h)
  h.telegram.failDeleteKey = 'verified-2'
  await h.api.handleAdminMessage({
    ...visitorMessage('/unblock', 1, 30),
    reply_to_message: { message_id: 700, chat: { id: 1 }, text: '你好' }
  })
  assert.equal(h.values.get('isblocked-2'), 'true')
  await h.api.onMessage(visitorMessage())
  assert.equal(h.telegram.forwards, 0)
}


async function main () {
  await testFirstContactGate()
  await testTwoRoundCaptcha()
  await testVerificationExpiryAndLegacyState()
  await testVerificationWriteFailureAndRecovery()
  await testInvalidPendingMessagesAreNotForwarded()
  await testBlocksOverrideTrustAndVerification()
  await testImmediateBlockAndUnblockRevokesPermissions()
  await testUnblockRevocationFailureKeepsBan()
  await testDelayedDuplicateCorrectAnswer()
  await testWrongAnswersAndConcurrency()
  await testDeleteFailureAndClaimRecovery()
  await testCaptchaWriteFailureDeletesMessage()
  await testCaptchaClaimRetries()
  await testPendingPreservation()
  await testForwardMappingAndAutomaticTrust()
  await testSpamFingerprintBlocking()
  await testForwardResultMessages()
  console.log('worker tests passed with first-contact verification and KV write-limit enforcement')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})

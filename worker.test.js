const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const { webcrypto } = require('node:crypto')

function createHarness () {
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
    claimFailures: 0
  }
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
      if (key.startsWith('captcha-claim-') && telegram.claimFailures-- > 0) throw new Error('KV unavailable')
      if (key.startsWith('captcha-') && !key.startsWith('captcha-claim-') && telegram.captchaFailures-- > 0) {
        throw new Error('KV unavailable')
      }
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
    ;globalThis.testApi = {
      createCaptcha, savePendingMessage, ensureCaptcha, onCallbackQuery, onMessage,
      forwardGuestMessage, handleAdminMessage, getMessageRiskScore,
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
    Date,
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
    setForwardOk (value) { forwardOk = value },
    setDeleteFailure (value) { forceDeleteFailure = value }
  }
}

function installActiveChallenge (h, uid = '2', messageId = 99, round = 1) {
  const state = h.api.createCaptcha(uid, Number(uid), 0, messageId, null, round)
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

async function testSilentRiskFlow () {
  const ordinary = createHarness()
  await ordinary.api.onMessage({
    from: { id: 2 },
    chat: { id: 2, type: 'private' },
    message_id: 10,
    text: '你好，我想咨询一个问题'
  })
  assert.equal(ordinary.telegram.forwards, 1)
  assert.equal(ordinary.values.has('captcha-2'), false)
  assert.equal(ordinary.values.has('pending-message-2'), false)
  await ordinary.api.onMessage({
    from: { id: 2 },
    chat: { id: 2, type: 'private' },
    message_id: 11,
    text: '再补充一条消息'
  })
  assert.equal(ordinary.telegram.forwards, 2)

  const suspicious = createHarness()
  await suspicious.api.onMessage(suspiciousMessage())
  const state = JSON.parse(suspicious.values.get('captcha-2'))
  const pending = JSON.parse(suspicious.values.get('pending-message-2'))
  const captchaMessage = suspicious.telegram.sent.find(message => message.reply_markup)
  assert.equal(suspicious.telegram.forwards, 0)
  assert.equal(pending.messageId, 10)
  assert.equal(state.round, 1)
  assert.equal(state.options.length, 6)
  assert.deepEqual(
    Array.from(vm.runInNewContext('value', { value: captchaMessage.reply_markup.inline_keyboard.map(row => row.length) })),
    [3, 3]
  )

  const forwardedTextBurst = createHarness()
  await forwardedTextBurst.api.onMessage({
    from: { id: 7 },
    chat: { id: 7, type: 'private' },
    message_id: 30,
    text: '还在一个一个群手动点发送？',
    forward_origin: { type: 'user' }
  })
  await forwardedTextBurst.api.onMessage({
    from: { id: 7 },
    chat: { id: 7, type: 'private' },
    message_id: 31,
    text: '一键开启全自动群发，真正解放双手。',
    forward_origin: { type: 'user' }
  })
  assert.equal(forwardedTextBurst.telegram.forwards, 0)
  assert.equal(JSON.parse(forwardedTextBurst.values.get('pending-message-7')).messageId, 30)
  assert.equal(forwardedTextBurst.telegram.sent.filter(message => message.reply_markup).length, 1)

  const splitDirectAd = createHarness()
  await splitDirectAd.api.onMessage({
    from: { id: 8 },
    chat: { id: 8, type: 'private' },
    message_id: 40,
    text: '还在一个一个群手动点发送？'
  })
  await splitDirectAd.api.onMessage({
    from: { id: 8 },
    chat: { id: 8, type: 'private' },
    message_id: 41,
    text: '一键开启全自动群发，真正解放双手。'
  })
  await splitDirectAd.api.onMessage({
    from: { id: 8 },
    chat: { id: 8, type: 'private' },
    message_id: 42,
    text: '频道：@FzdN1'
  })
  assert.equal(splitDirectAd.telegram.forwards, 0)
  assert.equal(JSON.parse(splitDirectAd.values.get('pending-message-8')).messageId, 40)
  assert.equal(splitDirectAd.telegram.sent.filter(message => message.reply_markup).length, 1)

  const forwardedMediaAd = createHarness()
  await forwardedMediaAd.api.onMessage({
    from: { id: 6 },
    chat: { id: 6, type: 'private' },
    message_id: 12,
    photo: [{ file_id: 'photo' }],
    forward_origin: { type: 'user' },
    via_bot: { id: 99, is_bot: true, username: 'PostBot' },
    reply_markup: {
      inline_keyboard: [[{ text: '官方频道', url: 'https://t.me/example' }]]
    }
  })
  assert.equal(forwardedMediaAd.telegram.forwards, 0)
  assert.ok(forwardedMediaAd.values.has('captcha-6'))

  const oldVerification = createHarness()
  oldVerification.values.set('verified-3', JSON.stringify({
    version: 2,
    expiresAt: Date.now() + 60000
  }))
  await oldVerification.api.onMessage(suspiciousMessage(3, 11))
  assert.ok(oldVerification.values.has('captcha-3'))
  assert.equal(oldVerification.telegram.forwards, 0)

  const trusted = createHarness()
  trusted.values.set('trusted-4', JSON.stringify({ trustedAt: Date.now() }))
  await trusted.api.onMessage(suspiciousMessage(4, 12))
  assert.equal(trusted.telegram.forwards, 1)
  assert.equal(trusted.values.has('captcha-4'), false)

  const start = createHarness()
  await start.api.onMessage({
    from: { id: 5 },
    chat: { id: 5, type: 'private' },
    message_id: 20,
    text: '/start'
  })
  assert.equal(start.telegram.forwards, 0)
  assert.equal(start.values.has('captcha-5'), false)
  assert.ok(start.telegram.sent.some(message => !message.reply_markup))
}

async function testTwoRoundCaptcha () {
  const h = createHarness()
  const first = installActiveChallenge(h)
  h.values.set('pending-message-2', JSON.stringify({
    chatId: 2,
    messageId: 10,
    expiresAt: first.expiresAt
  }))

  await h.api.onCallbackQuery(callback('2', first))
  const second = JSON.parse(h.values.get('captcha-2'))
  assert.equal(second.round, 2)
  assert.equal(h.telegram.forwards, 0)
  assert.equal(h.values.has('verified-2'), false)

  await h.api.onCallbackQuery(callback('2', second))
  assert.equal(h.values.has('verified-2'), false)
  assert.equal(JSON.parse(h.values.get('captcha-2')).status, 'completed')
  assert.equal(JSON.parse(h.values.get('pending-message-2')).status, 'completed')
  assert.equal(h.telegram.forwards, 1)
  assert.match(h.telegram.sent.at(-1).text, /验证成功/)

  await h.api.onMessage({
    from: { id: 2 },
    chat: { id: 2, type: 'private' },
    message_id: 11,
    text: '另一条转发广告',
    forward_origin: { type: 'user' }
  })
  assert.equal(h.telegram.forwards, 1)
  assert.equal(JSON.parse(h.values.get('captcha-2')).status, 'active')
  assert.equal(JSON.parse(h.values.get('pending-message-2')).messageId, 11)
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
  const h = createHarness()
  h.telegram.captchaFailures = 1
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
  assert.equal(exhausted.values.has('verified-2'), false)
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
}

async function testSpamFingerprintBlocking () {
  const h = createHarness()
  const ad = '推广投资高收益，请访问 https://spam.example.com 联系我们'
  h.values.set('msg-map-700', '2')
  h.values.set('trusted-2', JSON.stringify({ trustedAt: Date.now() }))
  h.values.set('verified-2', JSON.stringify({
    version: 2,
    expiresAt: Date.now() + 60000
  }))

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

async function testRiskScoring () {
  const h = createHarness()
  assert.equal(h.api.getMessageRiskScore({ text: '你好，我想咨询问题' }), 0)
  assert.ok(h.api.getMessageRiskScore({ text: '请查看 https://example.com' }) >= 3)
  assert.ok(h.api.getMessageRiskScore({ text: '投资合作请联系我 @example_user' }) >= 3)
  assert.ok(h.api.getMessageRiskScore({ text: '频道：@example_user' }) >= 3)
  assert.ok(h.api.getMessageRiskScore({ text: '一键开启全自动群发' }) >= 3)
  assert.ok(h.api.getMessageRiskScore({ text: '还在一个一个群手动点发送？' }) >= 3)
  assert.ok(h.api.getMessageRiskScore({ text: '群里消息为什么发送不出去？' }) < 3)
  assert.ok(h.api.getMessageRiskScore({ photo: [{}], caption: '问题截图' }) < 3)
  assert.ok(h.api.getMessageRiskScore({ text: '普通转发文字', forward_origin: { type: 'user' } }) >= 3)
  assert.ok(h.api.getMessageRiskScore({ photo: [{}], forward_origin: { type: 'user' } }) >= 3)
  assert.ok(h.api.getMessageRiskScore({ text: '机器人代发文字', via_bot: { is_bot: true } }) >= 3)
  assert.ok(h.api.getMessageRiskScore({
    reply_markup: { inline_keyboard: [[{ text: '打开', url: 'https://example.com' }]] }
  }) >= 3)
}

async function main () {
  await testSilentRiskFlow()
  await testTwoRoundCaptcha()
  await testDelayedDuplicateCorrectAnswer()
  await testWrongAnswersAndConcurrency()
  await testDeleteFailureAndClaimRecovery()
  await testCaptchaWriteFailureDeletesMessage()
  await testCaptchaClaimRetries()
  await testPendingPreservation()
  await testForwardMappingAndAutomaticTrust()
  await testSpamFingerprintBlocking()
  await testForwardResultMessages()
  await testRiskScoring()
  console.log('worker tests passed with silent risk control and KV write-limit enforcement')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})

const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const { webcrypto, createHmac } = require('node:crypto')

const BOT_TOKEN = 'test-bot-token'
const PUBLIC_URL = 'https://nfd.example.com'
const DAY = 24 * 60 * 60 * 1000
const TURNSTILE_ACTION = 'nfd_verify'

function createSharedState () {
  return {
    values: new Map(), lastWrites: new Map(), puts: [], deletes: [], logs: [],
    clock: { now: Date.now() }, liveMessages: new Set(), nextMessageId: 500,
    telegram: {
      forwards: 0, sent: [], deleted: [], copies: [], callbacks: [], forwardRequests: [],
      mapFailures: 0, captchaFailures: 0, claimFailures: 0, verifiedFailures: 0,
      auditFailures: 0, forwardOk: true, copyOk: true, forceDeleteFailure: false
    },
    turnstile: { requests: [], responses: new Map(), used: new Set(), nextToken: 0 }
  }
}

function createHarness ({ shared = createSharedState(), env = {} } = {}) {
  const { values, puts, telegram, liveMessages, turnstile } = shared
  const now = () => shared.clock.now
  class HarnessDate extends Date {
    constructor (...args) { super(...(args.length ? args : [now()])) }
    static now () { return now() }
  }
  // Timers retain their virtual deadlines and KV's 1-second write semantics,
  // while retry and HTTP timeout coverage completes without real-time sleeps.
  function advancingTimeout (fn, milliseconds = 0) {
    const due = now() + milliseconds
    return setTimeout(() => {
      shared.clock.now = Math.max(now(), due)
      fn()
    }, 0)
  }

  function enforceWriteLimit (key) {
    if (now() - (shared.lastWrites.get(key) || 0) < 1000) {
      const error = new Error(`429: KV key ${key} written more than once per second`)
      error.status = 429
      throw error
    }
    shared.lastWrites.set(key, now())
  }

  const nfd = {
    async get (key, options) {
      const value = values.get(key)
      if (value === undefined) return null
      return options?.type === 'json' && typeof value === 'string' ? JSON.parse(value) : value
    },
    async put (key, value, options) {
      enforceWriteLimit(key)
      puts.push({ key, value, options, at: now() })
      for (const [prefix, flag] of [
        ['verified-', 'verifiedFailures'], ['msg-map-', 'mapFailures'],
        ['captcha-claim-', 'claimFailures'], ['delivery-audit-', 'auditFailures']
      ]) {
        if (key.startsWith(prefix) && telegram[flag]-- > 0) throw new Error('KV unavailable')
      }
      if (key.startsWith('captcha-') && !key.startsWith('captcha-claim-') && telegram.captchaFailures-- > 0) {
        throw new Error('KV unavailable')
      }
      values.set(key, value)
      if (key.startsWith('verified-') && telegram.afterVerifiedWrite) telegram.afterVerifiedWrite()
    },
    async delete (key) {
      enforceWriteLimit(key)
      shared.deletes.push({ key, at: now() })
      if (telegram.failDeleteKey === key) throw new Error('KV unavailable')
      values.delete(key)
    }
  }

  const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' }
  })
  async function fetch (target, request = {}) {
    const url = String(target)
    if (url.endsWith('/data/startMessage.v4.md')) return new Response(fs.readFileSync('data/startMessage.v4.md', 'utf8'))
    if (url.endsWith('/data/adminMessage.v4.md')) return new Response(fs.readFileSync('data/adminMessage.v4.md', 'utf8'))
    if (url.endsWith('/data/fraud.db')) return new Response('')
    if (url === 'https://challenges.cloudflare.com/turnstile/v0/siteverify') {
      const body = typeof request.body === 'string' && request.body.startsWith('{')
        ? JSON.parse(request.body) : Object.fromEntries(new URLSearchParams(request.body))
      turnstile.requests.push({ url, ...body, signal: request.signal })
      if (turnstile.onRequest) await turnstile.onRequest(body)
      const configured = turnstile.responses.get(body.response)
      if (configured === 'timeout') {
        return new Promise((resolve, reject) => {
          if (request.signal?.aborted) return reject(new Error('aborted'))
          request.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
      }
      if (configured === 'throw') throw new Error('siteverify unavailable')
      if (configured === 'invalid-json') return new Response('not-json')
      if (configured === 'http-error') return jsonResponse({ success: true }, 503)
      if (!configured || turnstile.used.has(body.response)) return jsonResponse({ success: false, 'error-codes': ['timeout-or-duplicate'] })
      turnstile.used.add(body.response)
      return jsonResponse(configured)
    }
    if (!url.startsWith('https://api.telegram.org/bot')) throw new Error(`Unexpected network request: ${url}`)
    const method = new URL(url).pathname.split('/').pop()
    const body = request.body ? JSON.parse(request.body) : {}
    if (method === 'sendMessage') {
      const messageId = ++shared.nextMessageId
      telegram.sent.push({ ...body, messageId })
      liveMessages.add(messageId)
      return jsonResponse({ ok: true, result: { message_id: messageId } })
    }
    if (method === 'deleteMessage') {
      telegram.deleted.push(body)
      if (telegram.forceDeleteFailure || !liveMessages.has(body.message_id)) return jsonResponse({ ok: false })
      liveMessages.delete(body.message_id)
      if (telegram.afterDelete) telegram.afterDelete()
      return jsonResponse({ ok: true })
    }
    if (method === 'forwardMessage') {
      telegram.forwards++
      telegram.forwardRequests.push(body)
      return jsonResponse(telegram.forwardOk ? { ok: true, result: { message_id: 700 + telegram.forwards } } : { ok: false })
    }
    if (method === 'copyMessage') {
      telegram.copies.push(body)
      return jsonResponse({ ok: telegram.copyOk })
    }
    if (method === 'answerCallbackQuery') telegram.callbacks.push(body)
    return jsonResponse({ ok: true })
  }

  let fetchHandler
  const source = fs.readFileSync('worker.js', 'utf8') + `
    ;globalThis.testApi = {
      createCaptcha, savePendingMessage, ensureCaptcha, onCallbackQuery, onUpdate, onMessage,
      forwardGuestMessage, handleAdminMessage, getMessageFingerprint,
      handleVerifyPage, handleVerifyComplete, validateTelegramInitData, getVerificationConfig
    }
  `
  const context = {
    ENV_BOT_TOKEN: BOT_TOKEN, ENV_BOT_SECRET: 'secret', ENV_ADMIN_UID: 1,
    ENV_TURNSTILE_SITE_KEY: 'test-site-key', ENV_TURNSTILE_SECRET_KEY: 'test-turnstile-secret',
    ENV_PUBLIC_URL: PUBLIC_URL, ...env,
    addEventListener (type, handler) { if (type === 'fetch') fetchHandler = handler },
    crypto: webcrypto, TextEncoder, TextDecoder, Uint8Array, URL, URLSearchParams,
    Request, Response, Headers, AbortController, DOMException,
    console: {
      log (...args) { shared.logs.push(args.join(' ')) },
      error (...args) { shared.logs.push(args.join(' ')) },
      warn (...args) { shared.logs.push(args.join(' ')) }
    },
    Date: HarnessDate, Math, fetch, nfd,
    setTimeout: advancingTimeout, clearTimeout
  }
  vm.createContext(context)
  vm.runInContext(source, context)
  async function dispatch (request) {
    let response
    const pending = []
    fetchHandler({ request, respondWith (value) { response = value }, waitUntil (value) { pending.push(value) } })
    const result = await response
    await Promise.all(pending)
    return result
  }
  return {
    api: context.testApi, shared, values, puts, telegram, turnstile, liveMessages, now, dispatch,
    advance (milliseconds) { shared.clock.now += milliseconds }
  }
}

function visitorMessage (text = '你好', uid = 2, messageId = 10) {
  return { from: { id: uid }, chat: { id: uid, type: 'private' }, message_id: messageId, text }
}

function adminReply (text, adminMessageId = 701, messageId = 30, originalText = '你好') {
  return {
    ...visitorMessage(text, 1, messageId),
    reply_to_message: { message_id: adminMessageId, chat: { id: 1 }, text: originalText }
  }
}

function signInitData (h, overrides = {}, token = BOT_TOKEN) {
  const entries = {
    auth_date: String(Math.floor(h.now() / 1000)),
    query_id: 'test-query', user: JSON.stringify({ id: 2, first_name: '访客' }),
    signature: 'telegram-ed25519-signature-is-also-part-of-bot-hmac', ...overrides
  }
  const data = Object.entries(entries).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)])
  const check = data.slice().sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('\n')
  const secret = createHmac('sha256', 'WebAppData').update(token).digest()
  const hash = createHmac('sha256', secret).update(check).digest('hex')
  return new URLSearchParams([...data, ['hash', hash]]).toString()
}

function installVerification (h, uid = '2', overrides = {}) {
  const session = { version: 4, method: 'turnstile', verifiedAt: h.now(), expiresAt: h.now() + DAY, ...overrides }
  h.values.set(`verified-${uid}`, JSON.stringify(session))
  return session
}

function installActiveChallenge (h, uid = '2', messageId = 99) {
  const state = h.api.createCaptcha(uid, Number(uid), messageId)
  state.writtenAt = h.now() - 1200
  state.pendingChatId = Number(uid)
  state.pendingMessageId = 10
  state.pendingExpiresAt = state.expiresAt
  h.values.set(`captcha-${uid}`, JSON.stringify(state))
  h.liveMessages.add(messageId)
  return state
}

function installPending (h, state, overrides = {}) {
  const pending = { chatId: state.chatId, messageId: 10, status: 'active', expiresAt: state.expiresAt, ...overrides }
  h.values.set(`pending-message-${state.userId}`, JSON.stringify(pending))
  return pending
}

function issueToken (h, state, overrides = {}) {
  const token = `turnstile-token-${++h.turnstile.nextToken}`
  h.turnstile.responses.set(token, {
    success: true, hostname: new URL(PUBLIC_URL).hostname,
    action: TURNSTILE_ACTION, cdata: state.id, ...overrides
  })
  return token
}

function verificationRequest (h, state, overrides = {}, options = {}) {
  const body = {
    initData: signInitData(h, { user: JSON.stringify({ id: Number(state.userId), first_name: '访客' }) }),
    challengeId: state.id, turnstileToken: issueToken(h, state), ...overrides
  }
  return new Request(options.url || `${PUBLIC_URL}/verify/complete`, {
    method: options.method || 'POST',
    headers: { 'content-type': 'application/json', origin: PUBLIC_URL, ...options.headers },
    body: options.rawBody === undefined ? JSON.stringify(body) : options.rawBody
  })
}

async function complete (h, state, overrides = {}, options = {}) {
  return h.api.handleVerifyComplete(verificationRequest(h, state, overrides, options))
}

async function testFirstContactGate () {
  for (const content of [
    { text: '你好' }, { text: '在吗' }, { photo: [{ file_id: 'photo' }] },
    { video: { file_id: 'video' } }, { document: { file_id: 'document' } },
    { sticker: { file_id: 'sticker' } }, { text: '请访问 https://example.com 联系我们' }
  ]) {
    const h = createHarness()
    const message = { ...visitorMessage(), ...content }
    if (!('text' in content)) delete message.text
    await h.api.onMessage(message)
    const state = JSON.parse(h.values.get('captcha-2'))
    assert.equal(h.telegram.forwards, 0)
    assert.equal(state.method, 'turnstile')
    assert.equal(state.version, 3)
    assert.equal(state.status, 'active')
    const prompt = h.telegram.sent.find(item => item.reply_markup)
    const button = prompt.reply_markup.inline_keyboard.flat().find(item => item.web_app)
    assert.ok(button)
    const link = new URL(button.web_app.url)
    assert.equal(link.origin, PUBLIC_URL)
    assert.equal(link.pathname, '/verify')
    assert.equal(link.searchParams.get('challenge'), state.id)
    assert.equal(JSON.parse(h.values.get('pending-message-2')).messageId, 10)
    await h.api.onMessage(visitorMessage('只是打个招呼', 2, 11))
    await h.api.onMessage(visitorMessage('再补充一条', 2, 12))
    assert.equal(h.telegram.forwards, 0)
    assert.equal(JSON.parse(h.values.get('pending-message-2')).messageId, 10)
    assert.equal(h.telegram.sent.filter(item => item.reply_markup).length, 1)
  }
}

async function testRoutesStartAndPrivateMessages () {
  const h = createHarness()
  await h.api.onMessage(visitorMessage('/start', 5, 20))
  assert.equal(h.telegram.sent.at(-1).text, fs.readFileSync('data/startMessage.v4.md', 'utf8'))
  assert.equal(h.values.has('captcha-5'), false)
  assert.equal(h.values.has('verified-5'), false)
  await h.api.onMessage(visitorMessage('/start', 1, 21))
  assert.equal(h.telegram.sent.at(-1).text, fs.readFileSync('data/adminMessage.v4.md', 'utf8'))
  for (const type of ['group', 'supergroup', 'channel']) {
    await h.api.onUpdate({ message: { ...visitorMessage(), chat: { id: -2, type } } })
  }
  assert.equal(h.values.has('captcha-2'), false)
  assert.equal(h.telegram.forwards, 0)
  assert.doesNotMatch(fs.readFileSync('data/adminMessage.md', 'utf8'), /\/checkuser/)
  const unauthorized = await h.dispatch(new Request(`${PUBLIC_URL}/endpoint`, {
    method: 'POST', body: JSON.stringify({ message: visitorMessage() })
  }))
  assert.equal(unauthorized.status, 403)
  const accepted = await h.dispatch(new Request(`${PUBLIC_URL}/endpoint`, {
    method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 'secret' },
    body: JSON.stringify({ message: visitorMessage() })
  }))
  assert.equal(accepted.status, 200)
  assert.ok(h.values.has('captcha-2'))
  assert.equal(h.telegram.forwards, 0)
  assert.equal((await h.dispatch(new Request(`${PUBLIC_URL}/unknown`))).status, 404)
}

async function testVerificationPage () {
  const h = createHarness()
  const state = installActiveChallenge(h)
  const result = await h.dispatch(new Request(`${PUBLIC_URL}/verify?challenge=${state.id}`))
  assert.equal(result.status, 200)
  const html = await result.text()
  assert.match(html, /telegram-web-app\.js/)
  assert.match(html, /challenges\.cloudflare\.com/)
  assert.match(html, /test-site-key/)
  assert.match(html, /initData/)
  assert.match(html, /verify\/complete/)
  assert.doesNotMatch(html, /test-turnstile-secret|test-bot-token/)
  assert.equal(h.telegram.forwards, 0)
  assert.ok((await h.api.handleVerifyPage(new Request(`https://attacker.example/verify?challenge=${state.id}`))).status >= 400)
  const invalid = await h.api.handleVerifyPage(new Request(`${PUBLIC_URL}/verify?challenge=%3Cscript%3Ealert(1)%3C/script%3E`))
  assert.ok(invalid.status >= 400)
  assert.doesNotMatch(await invalid.text(), /<script>alert\(1\)<\/script>/)
}

async function testVerificationPageScriptWiring () {
  const h = createHarness()
  const state = installActiveChallenge(h)
  const response = await h.api.handleVerifyPage(new Request(`${PUBLIC_URL}/verify?challenge=${state.id}`))
  const html = await response.text()
  const inlineScripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter(([, attributes]) => !/\bsrc\s*=/.test(attributes))
  assert.equal(inlineScripts.length, 1)
  const script = new vm.Script(inlineScripts[0][2], { filename: 'generated-verification-page.js' })
  const rawInitData = signInitData(h)

  function runPage (initData, loadTurnstile = true) {
    const nodes = new Map(['status', 'retry', 'close', 'widget'].map(id => [id, {
      textContent: '', hidden: id === 'retry' || id === 'close', handlers: new Map(),
      addEventListener (event, handler) { this.handlers.set(event, handler) }
    }]))
    const calls = { renders: [], requests: [], resets: [], timers: [], ready: 0, expand: 0, close: 0 }
    const page = { response: { ok: true, forwarded: true }, responseStatus: 200 }
    const window = {
      Telegram: { WebApp: {
        initData,
        ready () { calls.ready++ },
        expand () { calls.expand++ },
        close () { calls.close++ }
      } },
      turnstile: {
        render (selector, options) { calls.renders.push({ selector, options }); return 'widget-id' },
        reset (id) { calls.resets.push(id) }
      }
    }
    const context = vm.createContext({
      window, document: { getElementById (id) { assert.ok(nodes.has(id), id); return nodes.get(id) } },
      setTimeout (fn, milliseconds) { calls.timers.push({ fn, milliseconds }); return calls.timers.length },
      async fetch (url, options) {
        calls.requests.push({ url, ...options })
        return new Response(JSON.stringify(page.response), { status: page.responseStatus })
      }
    })
    script.runInContext(context)
    if (loadTurnstile) window.onTurnstileReady()
    return { nodes, calls, page }
  }

  const valid = runPage(rawInitData)
  assert.equal(valid.calls.ready, 1)
  assert.equal(valid.calls.expand, 1)
  assert.equal(valid.calls.renders.length, 1)
  const { selector, options } = valid.calls.renders[0]
  assert.equal(selector, '#widget')
  assert.equal(options.sitekey, 'test-site-key')
  assert.equal(options.action, TURNSTILE_ACTION)
  assert.equal(options.cData, state.id)
  await options.callback('browser-turnstile-token')
  assert.equal(valid.calls.requests.length, 1)
  const submitted = valid.calls.requests[0]
  assert.equal(submitted.url, '/verify/complete')
  assert.equal(submitted.method, 'POST')
  assert.equal(submitted.headers['Content-Type'], 'application/json')
  assert.deepEqual(JSON.parse(submitted.body), {
    initData: rawInitData, challengeId: state.id, turnstileToken: 'browser-turnstile-token'
  })
  assert.match(valid.nodes.get('status').textContent, /验证完成.*首条消息已发送/)
  assert.equal(valid.nodes.get('close').hidden, false)
  valid.nodes.get('close').handlers.get('click')()
  assert.equal(valid.calls.close, 1)
  valid.calls.timers[0].fn()
  assert.match(valid.nodes.get('status').textContent, /验证完成/)

  const unavailable = runPage(rawInitData, false)
  assert.equal(unavailable.calls.timers[0].milliseconds, 15000)
  unavailable.calls.timers[0].fn()
  assert.match(unavailable.nodes.get('status').textContent, /加载失败/)
  assert.equal(unavailable.nodes.get('close').hidden, false)
  assert.equal(unavailable.calls.requests.length, 0)

  const rejected = runPage(rawInitData)
  rejected.page.response = { ok: false, error: 'invalid_identity' }
  rejected.page.responseStatus = 401
  await rejected.calls.renders[0].options.callback('rejected-token')
  assert.match(rejected.nodes.get('status').textContent, /身份信息已过期/)
  assert.equal(rejected.nodes.get('close').hidden, true)
  assert.equal(rejected.nodes.get('retry').hidden, false)
  rejected.nodes.get('retry').handlers.get('click')()
  assert.deepEqual(rejected.calls.resets, ['widget-id'])
  rejected.calls.renders[0].options['expired-callback']()
  assert.match(rejected.nodes.get('status').textContent, /过期/)

  for (const initData of ['', undefined]) {
    const missing = runPage(initData)
    assert.equal(missing.calls.renders.length, 0)
    assert.equal(missing.calls.requests.length, 0)
    assert.match(missing.nodes.get('status').textContent, /Telegram/)
    assert.equal(missing.nodes.get('close').hidden, true)
  }
}

async function testValidTurnstileAndFixedVerificationWindow () {
  const h = createHarness()
  await h.api.onMessage(visitorMessage())
  const state = JSON.parse(h.values.get('captcha-2'))
  const before = h.now()
  const result = await complete(h, state)
  assert.equal(result.status, 200)
  const payload = await result.json()
  assert.equal(payload.ok, true)
  assert.equal(payload.forwarded, true)
  const verified = JSON.parse(h.values.get('verified-2'))
  assert.equal(verified.version, 4)
  assert.equal(verified.method, 'turnstile')
  assert.ok(verified.verifiedAt >= before)
  assert.equal(verified.expiresAt - verified.verifiedAt, DAY)
  assert.equal(h.puts.find(item => item.key === 'verified-2').options.expirationTtl, 86400)
  assert.equal(h.values.has('trusted-2'), false)
  assert.equal(h.telegram.forwards, 1)
  assert.equal(h.telegram.forwardRequests[0].message_id, 10)
  assert.equal(JSON.parse(h.values.get('captcha-2')).status, 'completed')
  const challengeCount = h.telegram.sent.filter(item => item.reply_markup).length
  await h.api.onMessage(visitorMessage('https://example.com', 2, 11))
  await h.api.onMessage({ ...visitorMessage('', 2, 12), photo: [{ file_id: 'photo' }] })
  assert.equal(h.telegram.forwards, 3)
  assert.equal(h.telegram.sent.filter(item => item.reply_markup).length, challengeCount)
  assert.equal(h.values.get('verified-2'), JSON.stringify(verified))
  assert.equal(h.puts.filter(item => item.key === 'verified-2').length, 1)
}

async function testVerificationExpiryAndLegacyState () {
  const h = createHarness()
  const session = installVerification(h)
  h.advance(DAY - 1000)
  await h.api.onMessage(visitorMessage('最后一秒'))
  assert.equal(h.telegram.forwards, 1)
  assert.equal(h.values.get('verified-2'), JSON.stringify(session))
  h.advance(1000)
  await h.api.onMessage(visitorMessage('已到期', 2, 11))
  assert.equal(h.telegram.forwards, 1)
  assert.ok(h.values.has('captcha-2'))
  for (const stored of [
    { version: 2, expiresAt: h.now() + DAY },
    { version: 3, expiresAt: h.now() + DAY },
    { version: 4, method: 'emoji', expiresAt: h.now() + DAY },
    { version: 4, method: 'turnstile', expiresAt: h.now() - DAY },
    { version: 4 }, true
  ]) {
    const invalid = createHarness()
    invalid.values.set('verified-2', JSON.stringify(stored))
    await invalid.api.onMessage(visitorMessage())
    assert.equal(invalid.telegram.forwards, 0)
    assert.ok(invalid.values.has('captcha-2'))
  }
}

async function testInitDataValidation () {
  const h = createHarness()
  const valid = signInitData(h)
  const decoded = await h.api.validateTelegramInitData(valid)
  assert.equal(decoded.userId, '2')
  assert.equal(decoded.authDate, Math.floor(h.now() / 1000))
  for (const offset of [-600, 30]) {
    const accepted = await h.api.validateTelegramInitData(signInitData(h, { auth_date: Math.floor(h.now() / 1000) + offset }))
    assert.equal(accepted?.userId, '2')
  }
  for (const offset of [-601, 31]) {
    assert.equal(await h.api.validateTelegramInitData(signInitData(h, { auth_date: Math.floor(h.now() / 1000) + offset })), null)
  }
  assert.equal(await h.api.validateTelegramInitData(signInitData(h, { extra: 'x'.repeat(8193) })), null)
  const tampered = new URLSearchParams(valid)
  tampered.set('user', JSON.stringify({ id: 3 }))
  const extraTampered = new URLSearchParams(valid)
  extraTampered.set('signature', 'changed-without-recalculating-hmac')
  for (const data of [
    '', valid + '&user=' + encodeURIComponent(JSON.stringify({ id: 3 })),
    valid + '&hash=' + 'a'.repeat(64), valid + '&auth_date=1',
    tampered.toString(), extraTampered.toString(), signInitData(h, {}, 'wrong-token'),
    signInitData(h, { auth_date: Math.floor(h.now() / 1000) - 3600 }),
    signInitData(h, { auth_date: Math.floor(h.now() / 1000) + 3600 }),
    signInitData(h, { auth_date: 'NaN' }), signInitData(h, { user: '{invalid' }),
    signInitData(h, { user: JSON.stringify({ id: -2 }) }),
    signInitData(h, { user: JSON.stringify({ id: 2.5 }) }),
    signInitData(h, { user: JSON.stringify({ id: Number.MAX_SAFE_INTEGER + 1 }) }),
    signInitData(h, { user: JSON.stringify({ id: '2' }) }),
    signInitData(h, { user: JSON.stringify({ first_name: 'no-id' }) })
  ]) {
    assert.equal(await h.api.validateTelegramInitData(data), null, data.slice(0, 90))
  }
}

async function testIdentityAndChallengeBinding () {
  for (const kind of ['forged-signature', 'other-user', 'expired-initdata', 'future-initdata', 'duplicate-user', 'wrong-challenge', 'expired-challenge', 'completed-challenge', 'other-chat', 'legacy-challenge']) {
    const h = createHarness()
    const state = installActiveChallenge(h)
    installPending(h, state)
    const overrides = {}
    if (kind === 'forged-signature') overrides.initData = signInitData(h, {}, 'wrong-token')
    if (kind === 'other-user') overrides.initData = signInitData(h, { user: JSON.stringify({ id: 3 }) })
    if (kind === 'expired-initdata') overrides.initData = signInitData(h, { auth_date: Math.floor(h.now() / 1000) - 3600 })
    if (kind === 'future-initdata') overrides.initData = signInitData(h, { auth_date: Math.floor(h.now() / 1000) + 3600 })
    if (kind === 'duplicate-user') overrides.initData = signInitData(h) + '&user=%7B%22id%22%3A2%7D'
    if (kind === 'wrong-challenge') overrides.challengeId = webcrypto.randomUUID()
    if (kind === 'expired-challenge') state.expiresAt = h.now() - 1
    if (kind === 'completed-challenge') state.status = 'completed'
    if (kind === 'other-chat') state.chatId = 3
    if (kind === 'legacy-challenge') { state.version = 2; delete state.method }
    h.values.set('captcha-2', JSON.stringify(state))
    const response = await complete(h, state, overrides)
    assert.ok(response.status >= 400, kind)
    assert.equal(h.telegram.forwards, 0, kind)
    assert.equal(h.values.has('verified-2'), false, kind)
    assert.equal(h.turnstile.requests.length, 0, kind)
  }
}

async function testTurnstileResultValidation () {
  for (const response of [
    { success: false }, { hostname: 'attacker.example' }, { action: 'other_action' },
    { cdata: webcrypto.randomUUID() }, { success: 'true' },
    { cdata: undefined }, { action: undefined }, { hostname: undefined },
    'http-error', 'invalid-json', 'throw', 'timeout'
  ]) {
    const h = createHarness()
    const state = installActiveChallenge(h)
    installPending(h, state)
    const token = issueToken(h, state, typeof response === 'object' ? response : {})
    if (typeof response === 'string') h.turnstile.responses.set(token, response)
    const result = await complete(h, state, { turnstileToken: token })
    assert.ok(result.status >= 400, String(response))
    assert.equal(h.telegram.forwards, 0)
    assert.equal(h.values.has('verified-2'), false)
    assert.equal(h.liveMessages.has(state.messageId), true)
    assert.equal(h.turnstile.requests.length, 1)
    assert.equal(h.turnstile.requests[0].secret, 'test-turnstile-secret')
    if (response === 'timeout') assert.equal(h.turnstile.requests[0].signal.aborted, true)
  }
}

async function testMissingConfigAndRequestValidation () {
  for (const env of [
    { ENV_TURNSTILE_SITE_KEY: undefined }, { ENV_TURNSTILE_SECRET_KEY: undefined },
    { ENV_PUBLIC_URL: undefined }, { ENV_PUBLIC_URL: 'http://nfd.example.com' },
    { ENV_PUBLIC_URL: 'https://user:password@nfd.example.com' }
  ]) {
    const h = createHarness({ env })
    assert.equal(h.api.getVerificationConfig(), null)
    await h.api.onMessage(visitorMessage())
    assert.equal(h.telegram.forwards, 0)
    assert.equal(h.telegram.sent.some(item => item.reply_markup), false)
    const state = installActiveChallenge(h)
    assert.equal((await complete(h, state)).status, 503)
    assert.equal(h.values.has('verified-2'), false)
  }
  const h = createHarness()
  const state = installActiveChallenge(h)
  const requests = [
    verificationRequest(h, state, {}, { url: 'https://attacker.example/verify/complete' }),
    verificationRequest(h, state, {}, { headers: { origin: 'https://attacker.example' } }),
    verificationRequest(h, state, {}, { headers: { 'content-type': 'text/plain' } }),
    verificationRequest(h, state, {}, { rawBody: '{bad-json' }),
    verificationRequest(h, state, { padding: 'x'.repeat(17000) }),
    verificationRequest(h, state, { padding: '汉'.repeat(6000) }, { headers: { 'content-length': '1' } }),
    verificationRequest(h, state, { turnstileToken: '' }),
    verificationRequest(h, state, { initData: 123 }),
    verificationRequest(h, state, { challengeId: 'not-a-challenge' })
  ]
  for (const request of requests) assert.ok((await h.api.handleVerifyComplete(request)).status >= 400)
  assert.equal(h.telegram.forwards, 0)
  assert.equal(h.turnstile.requests.length, 0)
  assert.ok((await h.api.handleVerifyComplete(new Request(`${PUBLIC_URL}/verify/complete`))).status >= 400)
}

// This models Telegram returning success for one deletion. It is a regression
// for the existing best-effort claim, not proof of cross-instance atomicity.
async function testCommonCrossInstanceRace () {
  const shared = createSharedState()
  const first = createHarness({ shared })
  const second = createHarness({ shared })
  const state = installActiveChallenge(first)
  installPending(first, state)
  const requests = [verificationRequest(first, state), verificationRequest(second, state)]
  const results = await Promise.all([
    first.api.handleVerifyComplete(requests[0]), second.api.handleVerifyComplete(requests[1])
  ])
  assert.equal(results.filter(result => result.status === 200).length, 1)
  assert.equal(first.telegram.forwards, 1)
  assert.equal(first.puts.filter(item => item.key === 'verified-2').length, 1)
  assert.equal([...first.values.keys()].filter(key => key.startsWith('delivery-audit-')).length, 1)
  const repeated = await complete(first, state)
  assert.ok(repeated.status >= 400)
  assert.equal(first.telegram.forwards, 1)
}

async function testSameInstanceConcurrencyAndConsumedClaims () {
  const h = createHarness()
  const state = installActiveChallenge(h)
  installPending(h, state)
  const results = await Promise.all([complete(h, state), complete(h, state)])
  assert.equal(results.filter(result => result.status === 200).length, 1)
  assert.equal(h.telegram.forwards, 1)

  // Another isolate may still read an active challenge. The persisted claim
  // must reject its replay even if that old challenge snapshot is visible.
  h.values.set('captcha-2', JSON.stringify(state))
  const other = createHarness({ shared: h.shared })
  assert.ok((await complete(other, state)).status >= 400)
  assert.equal(h.telegram.forwards, 1)

  const claimed = createHarness()
  const claimedState = installActiveChallenge(claimed)
  installPending(claimed, claimedState)
  claimed.values.set(`captcha-claim-${claimedState.id}`, JSON.stringify({
    userId: '2', claimedAt: claimed.now()
  }))
  assert.ok((await complete(claimed, claimedState)).status >= 400)
  assert.equal(claimed.telegram.forwards, 0)
  assert.equal(claimed.telegram.deleted.length, 0)
  claimed.advance(31000)
  await claimed.api.ensureCaptcha(visitorMessage(), JSON.parse(claimed.values.get('pending-message-2')))
  const replacement = JSON.parse(claimed.values.get('captcha-2'))
  assert.notEqual(replacement.id, claimedState.id)
  assert.equal(replacement.expiresAt, claimedState.expiresAt)
}

async function testSameTurnstileTokenCannotBeReused () {
  const shared = createSharedState()
  const first = createHarness({ shared })
  const second = createHarness({ shared })
  const state = installActiveChallenge(first)
  installPending(first, state)
  const token = issueToken(first, state)
  const results = await Promise.all([
    complete(first, state, { turnstileToken: token }),
    complete(second, state, { turnstileToken: token })
  ])
  assert.equal(results.filter(result => result.status === 200).length, 1)
  assert.equal(first.telegram.forwards, 1)
  assert.equal(first.turnstile.used.has(token), true)
  assert.equal([...first.values.keys()].filter(key => key.startsWith('delivery-audit-')).length, 1)
}

async function testLegacyCallbackCannotGrantAccess () {
  const h = createHarness()
  const state = installActiveChallenge(h)
  h.values.set('captcha-2', JSON.stringify({ ...state, version: 2, round: 2, correctOptionId: '0' }))
  await h.api.onCallbackQuery({
    id: 'old-callback', from: { id: 2 }, data: `captcha:${state.id}:0`,
    message: { message_id: 99, chat: { id: 2, type: 'private' } }
  })
  assert.equal(h.values.has('verified-2'), false)
  assert.equal(h.telegram.forwards, 0)
  assert.equal(h.telegram.deleted.length, 0)
  assert.equal(h.telegram.callbacks.length, 1)
}

async function testBlocksDuringVerification () {
  for (const phase of ['already-blocked', 'siteverify', 'after-delete', 'after-grant']) {
    const h = createHarness()
    const state = installActiveChallenge(h)
    installPending(h, state)
    const block = () => h.values.set('isblocked-2', 'true')
    if (phase === 'already-blocked') block()
    if (phase === 'siteverify') h.turnstile.onRequest = block
    if (phase === 'after-delete') h.telegram.afterDelete = block
    if (phase === 'after-grant') h.telegram.afterVerifiedWrite = block
    const result = await complete(h, state)
    assert.ok(result.status >= 400, phase)
    assert.equal(h.telegram.forwards, 0, phase)
    assert.equal(h.values.has('verified-2'), false, phase)
  }
  for (const key of ['isblocked-2', 'captcha-block-2', 'rate-block-2']) {
    const h = createHarness()
    installVerification(h)
    h.values.set('trusted-2', JSON.stringify({ trustedAt: h.now() }))
    h.values.set(key, 'true')
    await h.api.onMessage(visitorMessage())
    assert.equal(h.telegram.forwards, 0, key)
  }
}

async function testChallengeReplacementDuringSiteverify () {
  const h = createHarness()
  const state = installActiveChallenge(h)
  installPending(h, state)
  const replacement = h.api.createCaptcha('2', 2, 100)
  h.turnstile.onRequest = () => h.values.set('captcha-2', JSON.stringify(replacement))
  const result = await complete(h, state)
  assert.ok(result.status >= 400)
  assert.equal(h.telegram.forwards, 0)
  assert.equal(h.values.has('verified-2'), false)
  assert.equal(h.telegram.deleted.length, 0)
  assert.equal(JSON.parse(h.values.get('captcha-2')).id, replacement.id)
}

async function testTemporaryRestrictionPreservesPermanentTrust () {
  const h = createHarness()
  const state = installActiveChallenge(h)
  installPending(h, state)
  const trust = JSON.stringify({ trustedAt: h.now() - DAY })
  h.values.set('trusted-2', trust)
  h.telegram.afterVerifiedWrite = () => h.values.set('rate-block-2', 'true')
  const response = await complete(h, state)
  assert.equal(response.status, 403)
  assert.equal(h.telegram.forwards, 0)
  assert.equal(h.values.get('trusted-2'), trust)
  assert.equal(h.values.has('verified-2'), false)
}

async function testExpiredGrantCannotConsumeNewChallengeGeneration () {
  for (const newerGrantExists of [false, true]) {
    const h = createHarness()
    const state = installActiveChallenge(h)
    state.expiresAt = h.now() + 500
    state.pendingExpiresAt = state.expiresAt
    h.values.set('captcha-2', JSON.stringify(state))
    installPending(h, state)
    h.telegram.verifiedFailures = 1
    let replacement
    let replacementPending
    let newerGrant
    h.telegram.afterVerifiedWrite = () => {
      replacementPending = {
        chatId: 2, messageId: 20, status: 'active', writtenAt: h.now(),
        expiresAt: h.now() + 600000
      }
      replacement = h.api.createCaptcha('2', 2, 100, replacementPending.expiresAt, replacementPending)
      h.values.set('captcha-2', JSON.stringify(replacement))
      h.values.set('pending-message-2', JSON.stringify(replacementPending))
      h.liveMessages.add(100)
      if (newerGrantExists) newerGrant = installVerification(h, '2', { challengeId: replacement.id })
    }
    const response = await complete(h, state)
    assert.equal(response.status, 409)
    assert.ok(h.now() > state.expiresAt)
    assert.equal(h.telegram.forwards, 0)
    if (newerGrantExists) assert.equal(h.values.get('verified-2'), JSON.stringify(newerGrant))
    else assert.equal(h.values.has('verified-2'), false)
    assert.equal(h.values.get('captcha-2'), JSON.stringify(replacement))
    assert.equal(h.values.get('pending-message-2'), JSON.stringify(replacementPending))
    assert.equal(h.liveMessages.has(100), true)
  }
}

async function testVerificationWriteFailureAndRecovery () {
  const retry = createHarness()
  const state = installActiveChallenge(retry)
  installPending(retry, state)
  retry.telegram.verifiedFailures = 2
  assert.equal((await complete(retry, state)).status, 200)
  const writes = retry.puts.filter(item => item.key === 'verified-2')
  assert.equal(writes.length, 3)
  assert.ok(writes[1].at - writes[0].at >= 1000)
  assert.ok(writes[2].at - writes[1].at >= 1000)
  assert.equal(retry.telegram.forwards, 1)

  const failed = createHarness()
  const failedState = installActiveChallenge(failed)
  installPending(failed, failedState)
  failed.telegram.verifiedFailures = 3
  assert.equal((await complete(failed, failedState)).status, 503)
  assert.equal(failed.telegram.forwards, 0)
  assert.equal(failed.values.has('verified-2'), false)
  assert.notEqual(JSON.parse(failed.values.get('pending-message-2')).status, 'completed')
  await failed.api.onMessage(visitorMessage('重试', 2, 11))
  const replacement = JSON.parse(failed.values.get('captcha-2'))
  assert.notEqual(replacement.id, failedState.id)
  assert.equal((await complete(failed, replacement)).status, 200)
  assert.equal(failed.telegram.forwards, 1)
  assert.equal(failed.telegram.forwardRequests[0].message_id, 10)
}

async function testClaimAndCaptchaFailureRecovery () {
  for (const failures of [2, 3]) {
    const h = createHarness()
    const state = installActiveChallenge(h)
    installPending(h, state)
    h.telegram.claimFailures = failures
    const response = await complete(h, state)
    assert.equal(h.puts.filter(item => item.key === `captcha-claim-${state.id}`).length, 3)
    assert.equal(response.status, failures === 2 ? 200 : 503)
    assert.equal(h.telegram.forwards, failures === 2 ? 1 : 0)
    if (failures === 3) {
      assert.equal(h.values.has('verified-2'), false)
      assert.equal(h.liveMessages.has(state.messageId), true)
      assert.equal(h.telegram.deleted.length, 0)
      await h.api.onMessage(visitorMessage('再试', 2, 11))
      const replacement = JSON.parse(h.values.get('captcha-2'))
      assert.equal(replacement.id, state.id)
      assert.equal((await complete(h, replacement)).status, 200)
      assert.equal(h.telegram.forwards, 1)
    }
  }
  for (const failures of [1, 3]) {
    const h = createHarness()
    h.telegram.captchaFailures = failures
    await h.api.onMessage(visitorMessage())
    const prompt = h.telegram.sent.find(item => item.reply_markup)
    assert.equal(h.telegram.forwards, 0)
    assert.equal(h.values.has('captcha-2'), failures === 1)
    assert.equal(h.liveMessages.has(prompt.messageId), failures === 1)
    assert.equal(h.telegram.deleted.length, failures === 1 ? 0 : 1)
  }
  const deletionFailed = createHarness()
  const state = installActiveChallenge(deletionFailed)
  installPending(deletionFailed, state)
  deletionFailed.telegram.forceDeleteFailure = true
  assert.ok((await complete(deletionFailed, state)).status >= 400)
  assert.equal(deletionFailed.telegram.forwards, 0)
  assert.equal(deletionFailed.values.has('verified-2'), false)
}

async function testInvalidPendingMessagesAndPreservation () {
  const h = createHarness()
  const [first, second] = await Promise.all([
    h.api.savePendingMessage(visitorMessage('first', 2, 10)),
    h.api.savePendingMessage(visitorMessage('second', 2, 11))
  ])
  assert.equal(first.messageId, 10)
  assert.equal(second.messageId, 10)
  assert.equal(h.puts.filter(item => item.key === 'pending-message-2').length, 1)
  for (const kind of ['absent', 'expired', 'completed', 'other-chat', 'missing-message']) {
    const invalid = createHarness()
    const state = installActiveChallenge(invalid)
    const pending = { chatId: 2, messageId: 10, status: 'active', expiresAt: state.expiresAt }
    if (kind === 'expired') pending.expiresAt = invalid.now() - 1
    if (kind === 'completed') pending.status = 'completed'
    if (kind === 'other-chat') pending.chatId = 3
    if (kind === 'missing-message') delete pending.messageId
    if (kind !== 'absent') invalid.values.set('pending-message-2', JSON.stringify(pending))
    const response = await complete(invalid, state)
    assert.equal(response.status, 200, kind)
    assert.equal((await response.json()).forwarded, false, kind)
    assert.equal(invalid.telegram.forwards, 0, kind)
    assert.equal(JSON.parse(invalid.values.get('verified-2')).version, 4, kind)
  }
}

async function testAutomaticTrustAndReplyFailures () {
  const h = createHarness()
  h.values.set('msg-map-701', '2')
  await h.api.handleAdminMessage(adminReply('收到'))
  const trust = JSON.parse(h.values.get('trusted-2'))
  assert.ok(trust.trustedAt)
  assert.equal(h.telegram.copies.length, 1)
  h.advance(DAY + 1000)
  await h.api.onMessage(visitorMessage('https://example.com'))
  assert.equal(h.telegram.forwards, 1)
  assert.equal(h.values.has('captcha-2'), false)
  const failed = createHarness()
  failed.values.set('msg-map-701', '2')
  failed.telegram.copyOk = false
  await failed.api.handleAdminMessage(adminReply('收到'))
  assert.equal(failed.telegram.copies.length, 1)
  assert.equal(failed.values.has('trusted-2'), false)
}

async function testImmediateBlockUnblockAndFailure () {
  const h = createHarness()
  const state = installActiveChallenge(h)
  installPending(h, state)
  assert.equal((await complete(h, state)).status, 200)
  await h.api.handleAdminMessage(adminReply('收到'))
  const auditBefore = h.values.get('delivery-audit-701')
  await h.api.handleAdminMessage(adminReply('/block', 701, 31))
  assert.equal(h.values.get('isblocked-2'), 'true')
  for (const key of ['trusted-2', 'verified-2', 'captcha-2', 'pending-message-2']) assert.equal(h.values.has(key), false, key)
  assert.equal(h.values.get('delivery-audit-701'), auditBefore)
  await h.api.onMessage(visitorMessage('被屏蔽', 2, 12))
  assert.equal(h.telegram.forwards, 1)
  await h.api.handleAdminMessage(adminReply('/unblock', 701, 32))
  await h.api.onMessage(visitorMessage('解封后', 2, 13))
  assert.equal(h.telegram.forwards, 1)
  assert.equal(JSON.parse(h.values.get('pending-message-2')).messageId, 13)
  assert.equal(h.values.has('verified-2'), false)

  const failed = createHarness()
  failed.values.set('msg-map-701', '2')
  failed.values.set('isblocked-2', 'true')
  installVerification(failed)
  failed.telegram.failDeleteKey = 'verified-2'
  await failed.api.handleAdminMessage(adminReply('/unblock'))
  assert.equal(failed.values.get('isblocked-2'), 'true')
  await failed.api.onMessage(visitorMessage())
  assert.equal(failed.telegram.forwards, 0)
}

async function testRateLimitStillAppliesAfterVerification () {
  const h = createHarness()
  h.shared.clock.now = Math.floor(h.now() / 60000) * 60000 + 1000
  installVerification(h)
  for (let index = 0; index < 6; index++) {
    await h.api.onMessage(visitorMessage(`message ${index}`, 2, 10 + index))
    h.advance(1100)
  }
  assert.equal(h.telegram.forwards, 5)
  assert.equal(h.values.has('captcha-2'), false)
}

async function testFingerprintRules () {
  const h = createHarness()
  const ad = '推广投资高收益，请访问 https://spam.example.com 联系我们'
  h.values.set('msg-map-701', '2')
  await h.api.handleAdminMessage(adminReply('/block', 701, 30, ad))
  const fingerprint = await h.api.getMessageFingerprint({ text: ad })
  assert.ok(h.values.has('spam-fingerprint-' + fingerprint))
  await h.api.onMessage(visitorMessage(ad, 3, 11))
  assert.equal(h.values.get('isblocked-3'), 'true')
  assert.equal(h.telegram.forwards, 0)
  const verified = createHarness()
  installVerification(verified)
  verified.values.set('spam-fingerprint-' + fingerprint, 'true')
  await verified.api.onMessage(visitorMessage(ad))
  assert.equal(verified.telegram.forwards, 1)
  assert.equal(verified.values.has('isblocked-2'), false)
}

async function testDeliveryAuditAndReadOnlyCheckuser () {
  const h = createHarness()
  const state = installActiveChallenge(h)
  installPending(h, state)
  assert.equal((await complete(h, state)).status, 200)
  const first = JSON.parse(h.values.get('delivery-audit-701'))
  assert.equal(first.version, 1)
  assert.equal(first.uid, '2')
  assert.equal(first.sourceMessageId, 10)
  assert.equal(first.adminMessageId, 701)
  assert.equal(first.reason, 'verification_pass')
  assert.equal(first.verificationMethod, 'turnstile')
  assert.equal(first.verificationExpiresAt - first.verifiedAt, DAY)
  assert.ok(first.deliveredAt >= first.decidedAt)
  assert.equal(h.puts.find(item => item.key === 'delivery-audit-701').options.expirationTtl, 2592000)
  await h.api.handleAdminMessage(adminReply('/checkuser'))
  assert.equal(h.telegram.copies.length, 0)
  assert.equal(h.values.has('trusted-2'), false)
  assert.match(h.telegram.sent.at(-1).text, /2/)
  assert.match(h.telegram.sent.at(-1).text, /Turnstile|turnstile/)
  const session = JSON.parse(h.values.get('verified-2'))
  await h.api.onMessage(visitorMessage('第二条', 2, 11))
  const second = JSON.parse(h.values.get('delivery-audit-702'))
  assert.equal(second.reason, 'verified_window')
  assert.equal(second.verifiedAt, session.verifiedAt)
  await h.api.handleAdminMessage(adminReply('收到', 702))
  await h.api.onMessage(visitorMessage('第三条', 2, 12))
  assert.equal(JSON.parse(h.values.get('delivery-audit-703')).reason, 'trusted')
  assert.equal(h.values.get('delivery-audit-701'), JSON.stringify(first))
  const copiesBefore = h.telegram.copies.length
  await h.api.handleAdminMessage(adminReply('/checkuser', 701, 35))
  assert.equal(h.telegram.copies.length, copiesBefore)
  assert.equal(h.values.get('delivery-audit-701'), JSON.stringify(first))

  const legacy = createHarness()
  legacy.values.set('msg-map-777', '2')
  await legacy.api.handleAdminMessage(adminReply('/checkuser', 777))
  assert.match(legacy.telegram.sent.at(-1).text, /未知/)
  assert.equal(legacy.telegram.copies.length, 0)
  assert.equal(legacy.values.has('trusted-2'), false)
  const auditOnly = createHarness()
  auditOnly.values.set('delivery-audit-701', JSON.stringify(first))
  await auditOnly.api.handleAdminMessage(adminReply('/checkuser'))
  assert.equal(auditOnly.telegram.copies.length, 0)
  assert.match(auditOnly.telegram.sent.at(-1).text, /2/)
}

async function testMappingAndAuditFailuresDoNotRepeatDelivery () {
  for (const flag of ['mapFailures', 'auditFailures']) {
    const h = createHarness()
    installVerification(h)
    h.telegram[flag] = 3
    await h.api.onMessage(visitorMessage())
    assert.equal(h.telegram.forwards, 1, flag)
    const prefix = flag === 'mapFailures' ? 'msg-map-' : 'delivery-audit-'
    assert.equal(h.puts.filter(item => item.key.startsWith(prefix)).length, 3, flag)
    assert.equal(h.values.has(prefix + '701'), false, flag)
  }
  const failed = createHarness()
  const state = installActiveChallenge(failed)
  installPending(failed, state)
  failed.telegram.forwardOk = false
  const response = await complete(failed, state)
  assert.equal(response.status, 200)
  assert.equal((await response.json()).forwarded, false)
  assert.equal(failed.values.has('delivery-audit-701'), false)
  assert.equal(failed.values.has('verified-2'), true)
}

const tests = [
  testFirstContactGate, testRoutesStartAndPrivateMessages, testVerificationPage, testVerificationPageScriptWiring,
  testValidTurnstileAndFixedVerificationWindow, testVerificationExpiryAndLegacyState,
  testInitDataValidation, testIdentityAndChallengeBinding, testTurnstileResultValidation,
  testMissingConfigAndRequestValidation, testCommonCrossInstanceRace,
  testSameInstanceConcurrencyAndConsumedClaims, testSameTurnstileTokenCannotBeReused,
  testLegacyCallbackCannotGrantAccess, testBlocksDuringVerification, testChallengeReplacementDuringSiteverify,
  testTemporaryRestrictionPreservesPermanentTrust, testExpiredGrantCannotConsumeNewChallengeGeneration,
  testVerificationWriteFailureAndRecovery, testClaimAndCaptchaFailureRecovery,
  testInvalidPendingMessagesAndPreservation, testAutomaticTrustAndReplyFailures,
  testImmediateBlockUnblockAndFailure, testRateLimitStillAppliesAfterVerification, testFingerprintRules,
  testDeliveryAuditAndReadOnlyCheckuser, testMappingAndAuditFailuresDoNotRepeatDelivery
]

async function main () {
  for (const test of tests) {
    await test()
    console.log(`ok ${test.name}`)
  }
  console.log(`worker tests passed: ${tests.length} Turnstile, delivery audit, and regression groups`)
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})

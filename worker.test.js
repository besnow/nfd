const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const { webcrypto, createHash } = require('node:crypto')
const { inflateSync } = require('node:zlib')

const DAY = 24 * 60 * 60 * 1000

function createSharedState () {
  const expiresAt = new Map()
  // Direct fixture writes intentionally have no simulated KV expiration;
  // only a successful nfd.put installs a TTL for that stored generation.
  const values = new class extends Map {
    set (key, value) { expiresAt.delete(key); return super.set(key, value) }
    delete (key) { expiresAt.delete(key); return super.delete(key) }
  }()
  return {
    values, expiresAt, lastWrites: new Map(), puts: [], deletes: [], logs: [],
    clock: { now: Date.now() }, liveMessages: new Set(), nextMessageId: 500,
    rendered: new Map(), photoAnswers: new Map(), putFailures: new Map(),
    telegram: {
      forwards: 0, sent: [], photos: [], deleted: [], copies: [], callbacks: [], forwardRequests: [],
      forwardOk: true, copyOk: true, photoOk: true, forceDeleteFailure: false
    }
  }
}

function createHarness ({ shared = createSharedState() } = {}) {
  const { values, puts, telegram, liveMessages } = shared
  const now = () => shared.clock.now
  class HarnessDate extends Date {
    constructor (...args) { super(...(args.length ? args : [now()])) }
    static now () { return now() }
  }
  // Real asynchronous turns, virtual deadlines: retry tests retain KV's
  // one-second-per-key write limit without waiting in real time.
  function advancingTimeout (fn, milliseconds = 0) {
    const due = now() + milliseconds
    return setTimeout(() => { shared.clock.now = Math.max(now(), due); fn() }, 0)
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
      const expiration = shared.expiresAt.get(key)
      if (expiration !== undefined && expiration <= now()) {
        values.delete(key)
        return null
      }
      const value = values.get(key)
      if (value === undefined) return null
      return options?.type === 'json' && typeof value === 'string' ? JSON.parse(value) : value
    },
    async put (key, value, options) {
      enforceWriteLimit(key)
      puts.push({ key, value, options, at: now() })
      for (const [prefix, failures] of shared.putFailures) {
        if (key.startsWith(prefix) && failures > 0) {
          shared.putFailures.set(prefix, failures - 1)
          throw new Error('KV unavailable')
        }
      }
      values.set(key, value)
      if (Number.isFinite(options?.expirationTtl)) shared.expiresAt.set(key, now() + options.expirationTtl * 1000)
      else if (Number.isFinite(options?.expiration)) shared.expiresAt.set(key, options.expiration * 1000)
      if (key.startsWith('verified-') && telegram.afterVerifiedWrite) await telegram.afterVerifiedWrite()
    },
    async delete (key) {
      enforceWriteLimit(key)
      shared.deletes.push({ key, at: now() })
      if (telegram.failDeleteKey === key) throw new Error('KV unavailable')
      values.delete(key)
    }
  }
  const jsonResponse = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
  async function fetch (target, request = {}) {
    const url = String(target)
    if (url.endsWith('/data/startMessage.v4.md')) return new Response(fs.readFileSync('data/startMessage.v4.md', 'utf8'))
    if (url.endsWith('/data/adminMessage.v4.md')) return new Response(fs.readFileSync('data/adminMessage.v4.md', 'utf8'))
    if (url.endsWith('/data/fraud.db')) return new Response('')
    if (!url.startsWith('https://api.telegram.org/bot')) throw new Error(`Unexpected network request: ${url}`)
    const method = new URL(url).pathname.split('/').pop()
    if (method === 'sendPhoto') {
      assert.ok(request.body instanceof FormData, 'sendPhoto must upload multipart FormData')
      const fields = Object.fromEntries(request.body.entries())
      assert.ok(fields.photo instanceof Blob)
      const png = Buffer.from(await fields.photo.arrayBuffer())
      const digest = createHash('sha256').update(png).digest('hex')
      const answer = shared.rendered.get(digest)
      assert.match(answer, /^[2-9]{5}$/, 'send the actual generated PNG')
      const messageId = ++shared.nextMessageId
      const metadata = Object.fromEntries(Object.entries(fields).filter(([key]) => key !== 'photo'))
      assert.equal(fields.photo.name, 'captcha.png')
      assert.equal(fields.photo.type, 'image/png')
      assert.equal(JSON.stringify(metadata).includes(answer), false, 'answer must not appear in Telegram text fields')
      telegram.photos.push({ ...metadata, filename: fields.photo.name, png, messageId })
      shared.photoAnswers.set(messageId, answer)
      if (!telegram.photoOk) return jsonResponse({ ok: false })
      liveMessages.add(messageId)
      return jsonResponse({ ok: true, result: { message_id: messageId, photo: [{ file_id: 'uploaded-photo' }] } })
    }
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
      if (telegram.afterDelete) await telegram.afterDelete()
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
  // Capture only at the rendering boundary in this test VM. The production
  // challenge/state/API never needs to return a plaintext answer for tests.
  const source = fs.readFileSync('worker.js', 'utf8') + `
    ;const originalCaptchaRendererForTest = renderCaptchaPng;
    renderCaptchaPng = function (answer) {
      const png = originalCaptchaRendererForTest(answer);
      captureRenderedCaptchaForTest(answer, png);
      return png;
    };
    globalThis.testApi = {
      createCaptcha, savePendingMessage, ensureCaptcha, onCallbackQuery, onUpdate, onMessage,
      forwardGuestMessage, handleAdminMessage, getMessageFingerprint, renderCaptchaPng
    };
  `
  const context = {
    // Only the three original deployment variables are provided.
    ENV_BOT_TOKEN: 'test-bot-token', ENV_BOT_SECRET: 'secret', ENV_ADMIN_UID: 1,
    addEventListener (type, handler) { if (type === 'fetch') fetchHandler = handler },
    captureRenderedCaptchaForTest (answer, png) {
      shared.rendered.set(createHash('sha256').update(Buffer.from(png)).digest('hex'), answer)
    },
    crypto: webcrypto, TextEncoder, TextDecoder, Uint8Array, Uint32Array, DataView,
    URL, URLSearchParams, Request, Response, Headers, Blob, FormData,
    console: {
      log (...args) { shared.logs.push(args.join(' ')) },
      error (...args) { shared.logs.push(args.join(' ')) },
      warn (...args) { shared.logs.push(args.join(' ')) }
    },
    Date: HarnessDate, Math, fetch, nfd, setTimeout: advancingTimeout, clearTimeout
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
    api: context.testApi, shared, values, puts, telegram, liveMessages, now, dispatch,
    advance (milliseconds) { shared.clock.now += milliseconds },
    failPuts (prefix, count) { shared.putFailures.set(prefix, count) }
  }
}

function visitorMessage (text = '你好', uid = 2, messageId = 10) {
  return { from: { id: uid }, chat: { id: uid, type: 'private' }, message_id: messageId, text }
}
function adminReply (text, adminMessageId = 701, messageId = 30, originalText = '你好') {
  return { ...visitorMessage(text, 1, messageId), reply_to_message: { message_id: adminMessageId, chat: { id: 1 }, text: originalText } }
}
function captchaReply (h, state, text = h.shared.photoAnswers.get(state.messageId), messageId = 20) {
  assert.equal(typeof text, 'string')
  return {
    ...visitorMessage(text, Number(state.userId), messageId),
    reply_to_message: { message_id: state.messageId, chat: { id: state.chatId, type: 'private' }, photo: [{ file_id: 'captcha-photo' }] }
  }
}
async function startChallenge (h, message = visitorMessage()) {
  await h.api.onMessage(message)
  const state = JSON.parse(h.values.get(`captcha-${message.from.id}`))
  assert.ok(state)
  return state
}
async function passChallenge (h, state, messageId = 20) {
  await h.api.onMessage(captchaReply(h, state, undefined, messageId))
}
function wrongAnswer (h, state) {
  return h.shared.photoAnswers.get(state.messageId) === '99999' ? '88888' : '99999'
}
function installVerification (h, uid = '2', overrides = {}) {
  const session = { version: 5, method: 'image', verifiedAt: h.now(), expiresAt: h.now() + DAY, ...overrides }
  h.values.set(`verified-${uid}`, JSON.stringify(session))
  return session
}

// Standard PNG chunk CRC verification and Node's native zlib decoder validate
// the produced file independently of the renderer's encoding implementation.
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})
function crc32 (bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
function decodePng (png) {
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
  const chunks = []
  let offset = 8
  while (offset < png.length) {
    const length = png.readUInt32BE(offset)
    const type = png.toString('ascii', offset + 4, offset + 8)
    const data = png.subarray(offset + 8, offset + 8 + length)
    assert.equal(png.readUInt32BE(offset + 8 + length), crc32(png.subarray(offset + 4, offset + 8 + length)), type)
    chunks.push({ type, data })
    offset += length + 12
  }
  assert.equal(offset, png.length)
  assert.equal(chunks[0].type, 'IHDR')
  assert.equal(chunks.at(-1).type, 'IEND')
  assert.ok(chunks.every(chunk => ['IHDR', 'IDAT', 'IEND'].includes(chunk.type)), 'no plaintext metadata chunks')
  const header = chunks[0].data
  const width = header.readUInt32BE(0)
  const height = header.readUInt32BE(4)
  assert.equal(width, 240)
  assert.equal(height, 90)
  assert.equal(header[8], 8)
  assert.equal(header[9], 0)
  const pixels = inflateSync(Buffer.concat(chunks.filter(chunk => chunk.type === 'IDAT').map(chunk => chunk.data)))
  assert.equal(pixels.length, height * (width + 1))
  for (let row = 0; row < height; row++) assert.equal(pixels[row * (width + 1)], 0)
  assert.ok(new Set(pixels).size > 8, 'the decoded image must contain visible glyphs and noise')
  return { width, height, pixels }
}

async function testFirstContactGateAndNativeDeployment () {
  for (const content of [
    { text: '你好' }, { text: '在吗' }, { text: '23456' }, { photo: [{ file_id: 'photo' }] },
    { video: { file_id: 'video' } }, { document: { file_id: 'document' } },
    { sticker: { file_id: 'sticker' } }, { text: 'https://example.com' }
  ]) {
    const h = createHarness()
    const message = { ...visitorMessage(), ...content }
    if (!('text' in content)) delete message.text
    const state = await startChallenge(h, message)
    assert.equal(state.version, 4)
    assert.equal(state.method, 'image')
    assert.equal(state.failures, 0)
    assert.equal(state.status, 'active')
    assert.equal(h.telegram.forwards, 0)
    assert.equal(h.telegram.photos.length, 1)
    const markup = JSON.parse(h.telegram.photos[0].reply_markup)
    assert.equal(markup.force_reply, true)
    assert.equal(JSON.parse(h.values.get('pending-message-2')).messageId, 10)
    await h.api.onMessage(visitorMessage('普通补充', 2, 11))
    await h.api.onMessage(visitorMessage('23456', 2, 12))
    assert.equal(h.telegram.forwards, 0)
    assert.equal(h.telegram.photos.length, 1)
    assert.equal(JSON.parse(h.values.get('captcha-2')).failures, 0)
    assert.equal(JSON.parse(h.values.get('pending-message-2')).messageId, 10)
  }
}

async function testPngEncodingAndAnswerPrivacy () {
  const h = createHarness()
  const state = await startChallenge(h)
  const photo = h.telegram.photos[0]
  decodePng(photo.png)
  const answer = h.shared.photoAnswers.get(state.messageId)
  assert.match(answer, /^[2-9]{5}$/)
  assert.equal(state.answer, undefined)
  assert.equal(state.answerText, undefined)
  assert.equal(state.code, undefined)
  assert.match(state.answerHash, /^[a-f0-9]{64}$/i)
  for (const { value } of h.puts) assert.equal(value.includes(`"${answer}"`), false)
  assert.equal(JSON.stringify(h.telegram.sent).includes(answer), false)
  assert.equal(JSON.stringify({ ...photo, png: undefined }).includes(answer), false)
  assert.equal(h.shared.logs.some(line => line.includes(answer)), false)
  const other = Buffer.from(h.api.renderCaptchaPng(answer === '23456' ? '87654' : '23456'))
  decodePng(other)
  assert.equal(photo.png.equals(other), false)
  for (const invalid of ['', '12345', '2345', '234567', 'hello']) assert.throws(() => h.api.renderCaptchaPng(invalid))
}

async function testRoutesStartAndPrivateMessages () {
  const h = createHarness()
  await h.api.onMessage(visitorMessage('/start', 5, 20))
  assert.equal(h.telegram.sent.at(-1).text, fs.readFileSync('data/startMessage.v4.md', 'utf8'))
  assert.equal(h.values.has('captcha-5'), false)
  await h.api.onMessage(visitorMessage('/start', 1, 21))
  assert.equal(h.telegram.sent.at(-1).text, fs.readFileSync('data/adminMessage.v4.md', 'utf8'))
  assert.doesNotMatch(fs.readFileSync('data/adminMessage.md', 'utf8'), /\/checkuser/)
  for (const type of ['group', 'supergroup', 'channel']) {
    await h.api.onUpdate({ message: { ...visitorMessage(), chat: { id: -2, type } } })
  }
  assert.equal(h.values.has('captcha-2'), false)
  const unauthorized = await h.dispatch(new Request('https://nfd.example/endpoint', { method: 'POST', body: JSON.stringify({ message: visitorMessage() }) }))
  assert.equal(unauthorized.status, 403)
  const accepted = await h.dispatch(new Request('https://nfd.example/endpoint', {
    method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 'secret' }, body: JSON.stringify({ message: visitorMessage() })
  }))
  assert.equal(accepted.status, 200)
  assert.ok(h.values.has('captcha-2'))
  assert.equal(h.telegram.forwards, 0)
  for (const path of ['/unknown', '/verify', '/verify/complete']) {
    assert.equal((await h.dispatch(new Request('https://nfd.example' + path))).status, 404)
  }
}

async function testCorrectAnswerAndFixedVerificationWindow () {
  const h = createHarness()
  const state = await startChallenge(h, visitorMessage('23456'))
  await passChallenge(h, state)
  const verified = JSON.parse(h.values.get('verified-2'))
  assert.equal(verified.version, 5)
  assert.equal(verified.method, 'image')
  assert.equal(verified.challengeId, state.id)
  assert.equal(verified.expiresAt - verified.verifiedAt, DAY)
  assert.equal(h.puts.find(item => item.key === 'verified-2').options.expirationTtl, 86400)
  assert.equal(h.values.has('trusted-2'), false)
  assert.equal(h.telegram.forwards, 1)
  assert.equal(h.telegram.forwardRequests[0].message_id, 10)
  assert.equal(JSON.parse(h.values.get('captcha-2')).status, 'completed')
  assert.equal(h.liveMessages.has(state.messageId), true, 'keep the prompt so late replies retain context')
  await h.api.onMessage(visitorMessage('https://example.com', 2, 21))
  await h.api.onMessage({ ...visitorMessage('', 2, 22), photo: [{ file_id: 'photo' }] })
  assert.equal(h.telegram.forwards, 3)
  assert.equal(h.telegram.photos.length, 1)
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
  for (const overrides of [
    { version: 2 }, { version: 3 }, { version: 4, method: 'turnstile' },
    { version: 5, method: 'turnstile' }, { version: 5, method: 'emoji' }, { expiresAt: 0 }
  ]) {
    const invalid = createHarness()
    installVerification(invalid, '2', overrides)
    await invalid.api.onMessage(visitorMessage())
    assert.equal(invalid.telegram.forwards, 0)
    assert.ok(invalid.values.has('captcha-2'))
  }
}

async function testOnlyRepliesToCurrentPromptCanAnswer () {
  const h = createHarness()
  const state = await startChallenge(h)
  const answer = h.shared.photoAnswers.get(state.messageId)
  await h.api.onMessage(visitorMessage(answer, 2, 11))
  await h.api.onMessage(captchaReply(h, state, 'not a code', 12))
  await h.api.onMessage({ ...captchaReply(h, state, answer, 13), reply_to_message: { message_id: 9999, chat: { id: 2 } } })
  assert.equal(h.telegram.forwards, 0)
  assert.equal(h.values.has('verified-2'), false)
  assert.equal(JSON.parse(h.values.get('captcha-2')).failures, 0)
  assert.equal(JSON.parse(h.values.get('pending-message-2')).messageId, 10)
  const otherUser = { ...captchaReply(h, state, answer, 14), from: { id: 3 }, chat: { id: 3, type: 'private' } }
  await h.api.onMessage(otherUser)
  assert.equal(h.values.has('verified-2'), false)
  assert.equal(h.values.has('verified-3'), false)
  await h.api.onMessage(captchaReply(h, state, `  ${answer}  `, 15))
  assert.equal(h.telegram.forwards, 1)
}

async function testWrongAnswersPreserveFailureCountAndDeadline () {
  const h = createHarness()
  const first = await startChallenge(h)
  h.advance(60000)
  const wrong = captchaReply(h, first, wrongAnswer(h, first), 20)
  await h.api.onMessage(wrong)
  const second = JSON.parse(h.values.get('captcha-2'))
  assert.notEqual(second.id, first.id)
  assert.notEqual(second.messageId, first.messageId)
  assert.equal(second.failures, 1)
  assert.equal(second.expiresAt, first.expiresAt)
  assert.equal(h.liveMessages.has(first.messageId), true)
  assert.equal(h.telegram.forwards, 0)
  const photoCount = h.telegram.photos.length
  await h.api.onMessage(wrong)
  await h.api.onMessage(captchaReply(h, first, wrong.text, 21))
  assert.equal(JSON.parse(h.values.get('captcha-2')).failures, 1)
  assert.equal(h.telegram.photos.length, photoCount)
  await h.api.onMessage(captchaReply(h, second, wrongAnswer(h, second), 22))
  assert.ok(JSON.parse(h.values.get('captcha-block-2')).blockedUntil > h.now())
  const blockWrite = h.puts.find(item => item.key === 'captcha-block-2')
  assert.equal(blockWrite.options.expirationTtl, 3600)
  assert.equal(h.telegram.forwards, 0)
  assert.equal(h.values.has('verified-2'), false)
  await passChallenge(h, second, 23)
  assert.equal(h.telegram.forwards, 0)
}

async function testWrongAnswerStateFailuresDoNotResetProtection () {
  for (const failBothRestrictionWrites of [false, true]) {
    const h = createHarness()
    const first = await startChallenge(h)
    h.failPuts('captcha-2', 3)
    await h.api.onMessage(captchaReply(h, first, wrongAnswer(h, first), 20))
    h.advance(31000)
    await h.api.onMessage(visitorMessage('恢复验证', 2, 21))
    const second = JSON.parse(h.values.get('captcha-2'))
    assert.notEqual(second.id, first.id)
    assert.equal(second.failures, 1)
    assert.equal(second.expiresAt, first.expiresAt)
    h.failPuts('captcha-block-', 3)
    if (failBothRestrictionWrites) h.failPuts('captcha-2', 3)
    await h.api.onMessage(captchaReply(h, second, wrongAnswer(h, second), 22))
    assert.equal(h.values.has('captcha-block-2'), false)
    const restricted = JSON.parse(h.values.get('captcha-2'))
    const claim = JSON.parse(h.values.get('captcha-attempt-2'))
    assert.equal(claim.failures, 2)
    assert.ok(claim.blockedUntil > h.now())
    if (failBothRestrictionWrites) assert.equal(restricted.failures, 1)
    else {
      assert.equal(restricted.failures, 2)
      assert.ok(restricted.blockedUntil > h.now())
    }
    const photosBefore = h.telegram.photos.length
    await h.api.onMessage(visitorMessage('不能绕过限制', 2, 23))
    await passChallenge(h, second, 24)
    assert.equal(h.telegram.forwards, 0)
    assert.equal(h.telegram.photos.length, photosBefore)
    // The ordinary captcha expires after ten minutes. A restriction stored
    // only behind that expiring record would disappear here despite its hour.
    h.advance(Math.max(0, first.expiresAt - h.now()) + 1000)
    await h.api.onMessage(visitorMessage('原验证会话已过期但仍应限制', 2, 25))
    assert.equal(h.telegram.photos.length, photosBefore)
    assert.equal(h.telegram.forwards, 0)
    h.advance(Math.max(0, claim.blockedUntil - h.now()) + 1)
    await h.api.onMessage(visitorMessage('限制到期后', 2, 26))
    assert.equal(JSON.parse(h.values.get('captcha-2')).failures, 0)
  }
}

async function testSecondWrongWriteCanCrossChallengeDeadline () {
  for (const delayedWrite of ['captcha-attempt-', 'captcha-answer-']) {
    const h = createHarness()
    const first = await startChallenge(h)
    await h.api.onMessage(captchaReply(h, first, wrongAnswer(h, first), 20))
    const second = JSON.parse(h.values.get('captcha-2'))
    h.advance(second.expiresAt - h.now() - 500)
    const answeredAt = h.now()
    h.failPuts(delayedWrite, 1)
    await h.api.onMessage(captchaReply(h, second, wrongAnswer(h, second), 21))
    assert.ok(h.now() > second.expiresAt, delayedWrite)
    const photosBefore = h.telegram.photos.length
    await h.api.onMessage(visitorMessage('到期后仍需限制', 2, 22))
    assert.equal(h.telegram.photos.length, photosBefore, delayedWrite)
    assert.equal(h.telegram.forwards, 0, delayedWrite)
    h.advance(5 * 60000)
    await h.api.onMessage(visitorMessage('五分钟后仍需限制', 2, 23))
    assert.equal(h.telegram.photos.length, photosBefore, delayedWrite)
    assert.equal(h.telegram.forwards, 0, delayedWrite)
    h.advance(Math.max(0, answeredAt + 3600000 - h.now()) + 1)
    await h.api.onMessage(visitorMessage('一小时后可重试', 2, 24))
    assert.equal(h.telegram.photos.length, photosBefore + 1, delayedWrite)
    assert.equal(JSON.parse(h.values.get('captcha-2')).failures, 0)
  }
}

async function testExpiredPromptAndNewSession () {
  const h = createHarness()
  const state = await startChallenge(h)
  h.advance(600000)
  await passChallenge(h, state)
  assert.equal(h.telegram.forwards, 0)
  assert.equal(h.values.has('verified-2'), false)
  await h.api.onMessage(visitorMessage('重新开始', 2, 21))
  const replacement = JSON.parse(h.values.get('captcha-2'))
  assert.notEqual(replacement.id, state.id)
  assert.equal(replacement.failures, 0)
  assert.ok(replacement.expiresAt > state.expiresAt)
  assert.equal(JSON.parse(h.values.get('pending-message-2')).messageId, 21)
}

async function testAnswerReplayNeverBecomesUserContent () {
  const h = createHarness()
  const state = await startChallenge(h)
  const answer = captchaReply(h, state)
  await h.api.onMessage(answer)
  assert.equal(h.telegram.forwards, 1)
  await h.api.onMessage(answer)
  await h.api.onMessage(visitorMessage(answer.text, 2, answer.message_id))
  await h.api.onMessage(captchaReply(h, state, answer.text, 21))
  assert.equal(h.telegram.forwards, 1)
  const answerMarker = h.puts.find(item => item.key === `captcha-answer-2-${answer.message_id}`)
  const promptMarker = h.puts.find(item => item.key === `captcha-prompt-2-${state.messageId}`)
  assert.equal(answerMarker.options.expirationTtl, 86400)
  assert.equal(promptMarker.options.expirationTtl, 30 * 86400)
  // A new, unquoted number is normal business content, not a replay.
  await h.api.onMessage(visitorMessage(answer.text, 2, 22))
  assert.equal(h.telegram.forwards, 2)
  await h.api.handleAdminMessage(adminReply('收到'))
  await h.api.onMessage(captchaReply(h, state, answer.text, 23))
  assert.equal(h.telegram.forwards, 2, 'permanent trust cannot turn an old captcha reply into content')
}

async function testSameInstanceConcurrentAnswers () {
  const h = createHarness()
  const state = await startChallenge(h)
  await Promise.all([passChallenge(h, state, 20), passChallenge(h, state, 21)])
  assert.equal(h.telegram.forwards, 1)
  assert.equal(h.puts.filter(item => item.key === 'verified-2').length, 1)
  const other = createHarness({ shared: h.shared })
  await passChallenge(other, state, 22)
  assert.equal(h.telegram.forwards, 1, 'a persisted consumed prompt rejects a later isolate replay')
}

async function testLegacyCallbacksAndChallengesCannotGrant () {
  const h = createHarness()
  h.values.set('captcha-2', JSON.stringify({
    version: 2, method: 'emoji', status: 'active', id: webcrypto.randomUUID(),
    userId: '2', chatId: 2, messageId: 99, round: 2, correctOptionId: '0', expiresAt: h.now() + 600000
  }))
  await h.api.onCallbackQuery({
    id: 'old-callback', from: { id: 2 }, data: 'captcha:old:0',
    message: { message_id: 99, chat: { id: 2, type: 'private' } }
  })
  assert.equal(h.values.has('verified-2'), false)
  assert.equal(h.telegram.forwards, 0)
  assert.equal(h.telegram.callbacks.length, 1)
  assert.equal(h.telegram.deleted.length, 0)
  await h.api.onMessage(visitorMessage())
  assert.equal(JSON.parse(h.values.get('captcha-2')).method, 'image')
  assert.equal(h.telegram.forwards, 0)
}

async function testPhotoAndStateFailuresRemainClosed () {
  for (const kind of ['send', 'state', 'prompt-marker']) {
    const h = createHarness()
    if (kind === 'send') h.telegram.photoOk = false
    if (kind === 'state') h.failPuts('captcha-2', 3)
    if (kind === 'prompt-marker') h.failPuts('captcha-prompt-2-', 3)
    await h.api.onMessage(visitorMessage())
    assert.equal(h.telegram.forwards, 0, kind)
    assert.equal(h.values.has('verified-2'), false, kind)
    assert.equal(h.values.has('captcha-2'), false, kind)
    if (kind !== 'send') assert.equal(h.liveMessages.has(h.telegram.photos[0].messageId), false, kind)
    h.telegram.photoOk = true
    await h.api.onMessage(visitorMessage('重试', 2, 11))
    const replacement = JSON.parse(h.values.get('captcha-2'))
    assert.ok(replacement)
    assert.equal(JSON.parse(h.values.get('pending-message-2')).messageId, 10)
    await passChallenge(h, replacement)
    assert.equal(h.telegram.forwards, 1, kind)
  }
  const transient = createHarness()
  transient.failPuts('captcha-2', 1)
  await startChallenge(transient)
  assert.equal(transient.telegram.photos.length, 1)
  assert.equal(transient.telegram.deleted.length, 0)
}

async function testWrongReplacementFailureRetainsAttemptBudget () {
  const h = createHarness()
  const state = await startChallenge(h)
  h.telegram.photoOk = false
  await h.api.onMessage(captchaReply(h, state, wrongAnswer(h, state), 20))
  assert.equal(h.values.has('verified-2'), false)
  assert.equal(h.telegram.forwards, 0)
  h.telegram.photoOk = true
  await h.api.onMessage(visitorMessage('重新获取图片', 2, 21))
  const replacement = JSON.parse(h.values.get('captcha-2'))
  assert.notEqual(replacement.id, state.id)
  assert.equal(replacement.failures, 1)
  assert.equal(replacement.expiresAt, state.expiresAt)
  await h.api.onMessage(captchaReply(h, replacement, wrongAnswer(h, replacement), 22))
  assert.ok(JSON.parse(h.values.get('captcha-block-2')).blockedUntil > h.now())
}

async function testClaimAndAnswerMarkerFailures () {
  for (const prefix of ['captcha-attempt-', 'captcha-answer-']) {
    const h = createHarness()
    const state = await startChallenge(h)
    h.failPuts(prefix, 3)
    await passChallenge(h, state, 20)
    assert.equal(h.telegram.forwards, 0, prefix)
    assert.equal(h.values.has('verified-2'), false, prefix)
    assert.equal(h.liveMessages.has(state.messageId), true)
    await passChallenge(h, state, 21)
    assert.equal(h.telegram.forwards, 1, prefix)
  }
  const stale = createHarness()
  const state = await startChallenge(stale)
  stale.values.set('captcha-attempt-2', JSON.stringify({ userId: '2', challengeId: state.id, claimedAt: stale.now() }))
  await passChallenge(stale, state, 20)
  assert.equal(stale.telegram.forwards, 0)
  stale.advance(31000)
  await stale.api.onMessage(visitorMessage('恢复', 2, 21))
  const replacement = JSON.parse(stale.values.get('captcha-2'))
  assert.notEqual(replacement.id, state.id)
  assert.equal(replacement.expiresAt, state.expiresAt)
  await passChallenge(stale, replacement, 22)
  assert.equal(stale.telegram.forwards, 1)
}

async function testVerificationWriteFailureAndRecovery () {
  const retry = createHarness()
  const state = await startChallenge(retry)
  retry.failPuts('verified-', 2)
  await passChallenge(retry, state)
  const writes = retry.puts.filter(item => item.key === 'verified-2')
  assert.equal(writes.length, 3)
  assert.ok(writes[1].at - writes[0].at >= 1000)
  assert.ok(writes[2].at - writes[1].at >= 1000)
  assert.equal(retry.telegram.forwards, 1)
  const failed = createHarness()
  const failedState = await startChallenge(failed)
  failed.failPuts('verified-', 3)
  await passChallenge(failed, failedState)
  assert.equal(failed.telegram.forwards, 0)
  assert.equal(failed.values.has('verified-2'), false)
  assert.notEqual(JSON.parse(failed.values.get('pending-message-2')).status, 'completed')
  await failed.api.onMessage(visitorMessage('重试', 2, 21))
  const replacement = JSON.parse(failed.values.get('captcha-2'))
  assert.notEqual(replacement.id, failedState.id)
  await passChallenge(failed, replacement, 22)
  assert.equal(failed.telegram.forwards, 1)
  assert.equal(failed.telegram.forwardRequests[0].message_id, 10)
}

async function testBlocksAndTemporaryRestrictionPreserveTrust () {
  for (const temporary of [false, true]) {
    const h = createHarness()
    const state = await startChallenge(h)
    const trust = JSON.stringify({ trustedAt: h.now() - DAY })
    h.values.set('trusted-2', trust)
    h.telegram.afterVerifiedWrite = () => h.values.set(temporary ? 'rate-block-2' : 'isblocked-2', 'true')
    await passChallenge(h, state)
    assert.equal(h.telegram.forwards, 0)
    assert.equal(h.values.has('verified-2'), false)
    if (temporary) assert.equal(h.values.get('trusted-2'), trust)
    else assert.equal(h.values.has('trusted-2'), false)
  }
  for (const key of ['isblocked-2', 'captcha-block-2', 'rate-block-2']) {
    const h = createHarness()
    const state = await startChallenge(h)
    installVerification(h)
    h.values.set('trusted-2', JSON.stringify({ trustedAt: h.now() }))
    h.values.set(key, 'true')
    await h.api.onMessage(visitorMessage('被屏蔽', 2, 11))
    await passChallenge(h, state)
    assert.equal(h.telegram.forwards, 0, key)
  }
}

async function testExpiredGrantCannotConsumeNewGeneration () {
  for (const newerGrantExists of [false, true]) {
    const h = createHarness()
    const state = await startChallenge(h)
    h.advance(1200)
    state.expiresAt = h.now() + 500
    state.pendingExpiresAt = state.expiresAt
    h.values.set('captcha-2', JSON.stringify(state))
    const oldPending = JSON.parse(h.values.get('pending-message-2'))
    oldPending.expiresAt = state.expiresAt
    h.values.set('pending-message-2', JSON.stringify(oldPending))
    h.failPuts('verified-', 1)
    let replacement
    let replacementPending
    let newerGrant
    h.telegram.afterVerifiedWrite = async () => {
      replacementPending = { chatId: 2, messageId: 30, status: 'active', writtenAt: h.now(), expiresAt: h.now() + 600000 }
      const generated = await h.api.createCaptcha('2', 2, 100, replacementPending.expiresAt, replacementPending)
      replacement = generated.state
      h.values.set('captcha-2', JSON.stringify(replacement))
      h.values.set('pending-message-2', JSON.stringify(replacementPending))
      if (newerGrantExists) newerGrant = installVerification(h, '2', { challengeId: replacement.id })
    }
    await passChallenge(h, state)
    assert.ok(replacement, 'the simulated concurrent generation must actually occur')
    assert.ok(h.now() > state.expiresAt)
    assert.equal(h.telegram.forwards, 0)
    if (newerGrantExists) assert.equal(h.values.get('verified-2'), JSON.stringify(newerGrant))
    else assert.equal(h.values.has('verified-2'), false)
    assert.equal(h.values.get('captcha-2'), JSON.stringify(replacement))
    assert.equal(h.values.get('pending-message-2'), JSON.stringify(replacementPending))
  }
}

async function testInvalidPendingAndPreservation () {
  const h = createHarness()
  const [first, second] = await Promise.all([
    h.api.savePendingMessage(visitorMessage('first', 2, 10)),
    h.api.savePendingMessage(visitorMessage('second', 2, 11))
  ])
  assert.equal(first.messageId, 10)
  assert.equal(second.messageId, 10)
  assert.equal(h.puts.filter(item => item.key === 'pending-message-2').length, 1)
  for (const kind of ['absent', 'expired', 'completed', 'other-chat', 'other-message']) {
    const invalid = createHarness()
    const state = await startChallenge(invalid)
    const pending = JSON.parse(invalid.values.get('pending-message-2'))
    if (kind === 'expired') pending.expiresAt = invalid.now() - 1
    if (kind === 'completed') pending.status = 'completed'
    if (kind === 'other-chat') pending.chatId = 3
    if (kind === 'other-message') pending.messageId = 99
    if (kind === 'absent') invalid.values.delete('pending-message-2')
    else invalid.values.set('pending-message-2', JSON.stringify(pending))
    await passChallenge(invalid, state)
    assert.equal(invalid.telegram.forwards, 0, kind)
    assert.equal(JSON.parse(invalid.values.get('verified-2')).version, 5, kind)
  }
}

async function testAutomaticTrustAndReplyFailures () {
  const h = createHarness()
  h.values.set('msg-map-701', '2')
  await h.api.handleAdminMessage(adminReply('收到'))
  assert.ok(JSON.parse(h.values.get('trusted-2')).trustedAt)
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

async function testImmediateBlockUnblockPreservesAuditAndTombstones () {
  const h = createHarness()
  const state = await startChallenge(h)
  await passChallenge(h, state)
  await h.api.handleAdminMessage(adminReply('收到'))
  const audit = h.values.get('delivery-audit-701')
  const markers = [...h.values].filter(([key]) => key.startsWith('captcha-prompt-') || key.startsWith('captcha-answer-'))
  await h.api.handleAdminMessage(adminReply('/block', 701, 31))
  assert.equal(h.values.get('isblocked-2'), 'true')
  for (const key of ['trusted-2', 'verified-2', 'captcha-2', 'pending-message-2']) assert.equal(h.values.has(key), false, key)
  assert.equal(h.values.get('delivery-audit-701'), audit)
  for (const [key, value] of markers) assert.equal(h.values.get(key), value)
  await h.api.handleAdminMessage(adminReply('/unblock', 701, 32))
  await h.api.onMessage(captchaReply(h, state, undefined, 21))
  assert.equal(h.telegram.forwards, 1)
  await h.api.onMessage(visitorMessage('解封后', 2, 22))
  assert.equal(h.telegram.forwards, 1)
  assert.equal(JSON.parse(h.values.get('pending-message-2')).messageId, 22)
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

async function testRateLimitAndFingerprintRules () {
  const h = createHarness()
  h.shared.clock.now = Math.floor(h.now() / 60000) * 60000 + 1000
  installVerification(h)
  for (let index = 0; index < 6; index++) {
    await h.api.onMessage(visitorMessage(`message ${index}`, 2, 10 + index))
    h.advance(1100)
  }
  assert.equal(h.telegram.forwards, 5)
  const spam = createHarness()
  const ad = '推广投资高收益，请访问 https://spam.example.com 联系我们'
  spam.values.set('msg-map-701', '2')
  await spam.api.handleAdminMessage(adminReply('/block', 701, 30, ad))
  const fingerprint = await spam.api.getMessageFingerprint({ text: ad })
  assert.ok(spam.values.has('spam-fingerprint-' + fingerprint))
  await spam.api.onMessage(visitorMessage(ad, 3, 11))
  assert.equal(spam.values.get('isblocked-3'), 'true')
  assert.equal(spam.telegram.forwards, 0)
  const verified = createHarness()
  installVerification(verified)
  verified.values.set('spam-fingerprint-' + fingerprint, 'true')
  await verified.api.onMessage(visitorMessage(ad))
  assert.equal(verified.telegram.forwards, 1)
}

async function testDeliveryAuditAndReadOnlyCheckuser () {
  const h = createHarness()
  const state = await startChallenge(h)
  await passChallenge(h, state)
  const first = JSON.parse(h.values.get('delivery-audit-701'))
  assert.equal(first.version, 1)
  assert.equal(first.uid, '2')
  assert.equal(first.sourceMessageId, 10)
  assert.equal(first.adminMessageId, 701)
  assert.equal(first.reason, 'verification_pass')
  assert.equal(first.verificationMethod, 'image')
  assert.equal(first.verificationExpiresAt - first.verifiedAt, DAY)
  assert.ok(first.deliveredAt >= first.decidedAt)
  assert.equal(h.puts.find(item => item.key === 'delivery-audit-701').options.expirationTtl, 30 * 86400)
  await h.api.handleAdminMessage(adminReply('/checkuser'))
  assert.equal(h.telegram.copies.length, 0)
  assert.equal(h.values.has('trusted-2'), false)
  assert.match(h.telegram.sent.at(-1).text, /图片|image/)
  await h.api.onMessage(visitorMessage('第二条', 2, 21))
  const second = JSON.parse(h.values.get('delivery-audit-702'))
  assert.equal(second.reason, 'verified_window')
  assert.equal(second.verifiedAt, first.verifiedAt)
  await h.api.handleAdminMessage(adminReply('收到', 702))
  await h.api.onMessage(visitorMessage('第三条', 2, 22))
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
  for (const prefix of ['msg-map-', 'delivery-audit-']) {
    const h = createHarness()
    installVerification(h)
    h.failPuts(prefix, 3)
    await h.api.onMessage(visitorMessage())
    assert.equal(h.telegram.forwards, 1, prefix)
    assert.equal(h.puts.filter(item => item.key.startsWith(prefix)).length, 3, prefix)
    assert.equal(h.values.has(prefix + '701'), false, prefix)
  }
  const failed = createHarness()
  const state = await startChallenge(failed)
  failed.telegram.forwardOk = false
  await passChallenge(failed, state)
  assert.equal(failed.telegram.forwards, 1)
  assert.equal(failed.values.has('delivery-audit-701'), false)
  assert.equal(failed.values.has('verified-2'), true)
}

const tests = [
  testFirstContactGateAndNativeDeployment, testPngEncodingAndAnswerPrivacy,
  testRoutesStartAndPrivateMessages, testCorrectAnswerAndFixedVerificationWindow,
  testVerificationExpiryAndLegacyState, testOnlyRepliesToCurrentPromptCanAnswer,
  testWrongAnswersPreserveFailureCountAndDeadline, testWrongAnswerStateFailuresDoNotResetProtection,
  testSecondWrongWriteCanCrossChallengeDeadline,
  testExpiredPromptAndNewSession,
  testAnswerReplayNeverBecomesUserContent, testSameInstanceConcurrentAnswers,
  testLegacyCallbacksAndChallengesCannotGrant, testPhotoAndStateFailuresRemainClosed,
  testWrongReplacementFailureRetainsAttemptBudget, testClaimAndAnswerMarkerFailures,
  testVerificationWriteFailureAndRecovery, testBlocksAndTemporaryRestrictionPreserveTrust,
  testExpiredGrantCannotConsumeNewGeneration, testInvalidPendingAndPreservation,
  testAutomaticTrustAndReplyFailures, testImmediateBlockUnblockPreservesAuditAndTombstones,
  testRateLimitAndFingerprintRules, testDeliveryAuditAndReadOnlyCheckuser,
  testMappingAndAuditFailuresDoNotRepeatDelivery
]

async function main () {
  for (const test of tests) {
    await test()
    console.log(`ok ${test.name}`)
  }
  console.log(`worker tests passed: ${tests.length} native image verification, delivery audit, and regression groups`)
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})

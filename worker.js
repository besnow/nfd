const TOKEN = ENV_BOT_TOKEN // Get it from @BotFather
const WEBHOOK = '/endpoint'
const SECRET = ENV_BOT_SECRET // A-Z, a-z, 0-9, _ and -
const ADMIN_UID = ENV_ADMIN_UID.toString() // your user id, get it from https://t.me/username_to_id_bot

const CAPTCHA_TTL_SECONDS = 10 * 60
const CAPTCHA_PROCESSING_TIMEOUT_MS = 30 * 1000
const CAPTCHA_VERSION = 4
const CAPTCHA_MAX_FAILURES = 2
const CAPTCHA_BLOCK_SECONDS = 60 * 60
const VERIFIED_VERSION = 5
const VERIFIED_TTL_SECONDS = 24 * 60 * 60
const SPAM_FINGERPRINT_TTL_SECONDS = 30 * 24 * 60 * 60
const RATE_BLOCK_SECONDS = 24 * 60 * 60
const DELIVERY_AUDIT_TTL_SECONDS = 30 * 24 * 60 * 60
const CAPTCHA_PROMPT_TTL_SECONDS = 30 * 24 * 60 * 60
const CAPTCHA_ANSWER_TTL_SECONDS = 24 * 60 * 60
const fraudDb = 'https://raw.githubusercontent.com/LloydAsp/nfd/main/data/fraud.db'
const startMsgUrl = 'https://raw.githubusercontent.com/besnow/nfd/main/data/startMessage.v4.md'
const adminMsgUrl = 'https://raw.githubusercontent.com/besnow/nfd/main/data/adminMessage.v4.md'

const pendingSaveQueues = new Map()
const captchaCreationQueues = new Map()
const captchaAnswerQueues = new Map()

// Self-contained PNG renderer for Workers. The answer is drawn into pixels only;
// no answer, text chunk, font dependency, or external rendering service is used.
const CAPTCHA_PNG_DIGITS = {
  '2': [0b0111110, 0b1100011, 0b0000011, 0b0000011, 0b0000110, 0b0001100, 0b0011000, 0b0110000, 0b1100000, 0b1111111],
  '3': [0b0111110, 0b1100011, 0b0000011, 0b0000011, 0b0011110, 0b0000011, 0b0000011, 0b0000011, 0b1100011, 0b0111110],
  '4': [0b0001100, 0b0011100, 0b0111100, 0b1101100, 0b1101100, 0b1101100, 0b1111111, 0b0001100, 0b0001100, 0b0001100],
  '5': [0b1111111, 0b1100000, 0b1100000, 0b1100000, 0b1111110, 0b0000011, 0b0000011, 0b0000011, 0b1100011, 0b0111110],
  '6': [0b0011110, 0b0110000, 0b1100000, 0b1100000, 0b1111110, 0b1100011, 0b1100011, 0b1100011, 0b1100011, 0b0111110],
  '7': [0b1111111, 0b0000011, 0b0000011, 0b0000110, 0b0001100, 0b0011000, 0b0011000, 0b0011000, 0b0011000, 0b0011000],
  '8': [0b0111110, 0b1100011, 0b1100011, 0b1100011, 0b0111110, 0b1100011, 0b1100011, 0b1100011, 0b1100011, 0b0111110],
  '9': [0b0111110, 0b1100011, 0b1100011, 0b1100011, 0b1100011, 0b0111111, 0b0000011, 0b0000011, 0b0000110, 0b0111100]
}

const CAPTCHA_PNG_CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < table.length; n++) {
    let value = n
    for (let bit = 0; bit < 8; bit++) {
      value = (value & 1) ? 0xEDB88320 ^ (value >>> 1) : value >>> 1
    }
    table[n] = value >>> 0
  }
  return table
})()

function captchaPngWriteUint32 (bytes, offset, value) {
  bytes[offset] = value >>> 24
  bytes[offset + 1] = value >>> 16
  bytes[offset + 2] = value >>> 8
  bytes[offset + 3] = value
}

function captchaPngChunk (type, data) {
  const chunk = new Uint8Array(data.length + 12)
  captchaPngWriteUint32(chunk, 0, data.length)
  for (let i = 0; i < 4; i++) chunk[4 + i] = type.charCodeAt(i)
  chunk.set(data, 8)
  let crc = 0xFFFFFFFF
  for (let i = 4; i < chunk.length - 4; i++) {
    crc = CAPTCHA_PNG_CRC_TABLE[(crc ^ chunk[i]) & 0xFF] ^ (crc >>> 8)
  }
  captchaPngWriteUint32(chunk, chunk.length - 4, (crc ^ 0xFFFFFFFF) >>> 0)
  return chunk
}

function captchaPngDeflateStored (raw) {
  // RFC 1950 zlib header and RFC 1951 byte-aligned, uncompressed DEFLATE
  // blocks. Each block is bounded by the 16-bit LEN field.
  const count = Math.max(1, Math.ceil(raw.length / 65535))
  const packed = new Uint8Array(2 + raw.length + count * 5 + 4)
  packed[0] = 0x78
  packed[1] = 0x01
  let offset = 2
  let cursor = 0
  for (let block = 0; block < count; block++) {
    const length = Math.min(65535, raw.length - cursor)
    const inverse = (~length) & 0xFFFF
    packed[offset++] = block === count - 1 ? 1 : 0
    packed[offset++] = length & 0xFF
    packed[offset++] = length >>> 8
    packed[offset++] = inverse & 0xFF
    packed[offset++] = inverse >>> 8
    packed.set(raw.subarray(cursor, cursor + length), offset)
    offset += length
    cursor += length
  }
  let a = 1
  let b = 0
  // Bounded batches keep the Adler sums within exact integer range.
  for (let start = 0; start < raw.length; start += 5552) {
    const end = Math.min(raw.length, start + 5552)
    for (let i = start; i < end; i++) {
      a += raw[i]
      b += a
    }
    a %= 65521
    b %= 65521
  }
  captchaPngWriteUint32(packed, offset, ((b << 16) | a) >>> 0)
  return packed
}

function renderCaptchaPng (answer) {
  if (typeof answer !== 'string' || !/^[2-9]{5}$/.test(answer)) {
    throw new Error('Invalid captcha image input')
  }
  const width = 240
  const height = 90
  const pixels = new Uint8Array(width * height)
  pixels.fill(250)
  const randomValues = new Uint32Array(256)
  let randomIndex = randomValues.length
  function random () {
    if (randomIndex === randomValues.length) {
      crypto.getRandomValues(randomValues)
      randomIndex = 0
    }
    return randomValues[randomIndex++] / 4294967296
  }
  function blend (x, y, shade, alpha) {
    if (x < 0 || x >= width || y < 0 || y >= height) return
    const offset = y * width + x
    pixels[offset] = Math.round(pixels[offset] * (1 - alpha) + shade * alpha)
  }
  function noiseLine (shade, opacity) {
    const y0 = 12 + random() * 66
    const slope = (random() - 0.5) * 0.13
    const phase = random() * Math.PI * 2
    const amplitude = 3 + random() * 5
    const frequency = 0.012 + random() * 0.012
    for (let x = 4; x < width - 4; x++) {
      const y = y0 + slope * (x - width / 2) + amplitude * Math.sin(x * frequency + phase)
      const row = Math.floor(y)
      const fraction = y - row
      blend(x, row, shade, opacity * (1 - fraction))
      blend(x, row + 1, shade, opacity * fraction)
    }
  }

  // Restrained, low-contrast noise preserves readability on small phone screens.
  for (let i = 0; i < 3; i++) noiseLine(196, 0.65)
  for (let i = 0; i < 50; i++) {
    const x = 5 + Math.floor(random() * 230)
    const y = 5 + Math.floor(random() * 80)
    blend(x, y, 152, 0.4)
    if (random() > 0.5) blend(x + 1, y, 152, 0.25)
  }

  for (let index = 0; index < answer.length; index++) {
    const rows = CAPTCHA_PNG_DIGITS[answer[index]]
    const scaleX = 4.0 + random() * 0.4
    const scaleY = 4.5 + random() * 0.5
    const centerX = 34 + index * 43 + (random() - 0.5) * 4
    const centerY = 45 + (random() - 0.5) * 6
    const angle = (random() - 0.5) * 0.18
    const cosine = Math.cos(angle)
    const sine = Math.sin(angle)
    const shade = 32 + Math.floor(random() * 32)
    const x0 = Math.max(0, Math.floor(centerX - 21))
    const x1 = Math.min(width - 1, Math.ceil(centerX + 21))
    const y0 = Math.max(0, Math.floor(centerY - 29))
    const y1 = Math.min(height - 1, Math.ceil(centerY + 29))
    const inverseX = 1 / scaleX
    const inverseY = 1 / scaleY
    for (let y = y0; y <= y1; y++) {
      const dy = y + 0.5 - centerY
      const sineY = sine * dy
      const cosineY = cosine * dy
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - centerX
        const column = (cosine * dx + sineY) * inverseX + 3.5
        const row = (-sine * dx + cosineY) * inverseY + 5
        // Coordinates are nonnegative after the bounds checks, so truncation
        // is equivalent to floor without a function call for every pixel.
        if (row >= 0 && row < 10 && column >= 0 && column < 7 &&
          (rows[row | 0] & (1 << (6 - (column | 0)))) !== 0) {
          pixels[y * width + x] = shade
        }
      }
    }
  }
  noiseLine(150, 0.35)

  const stride = width + 1
  const raw = new Uint8Array(stride * height)
  for (let y = 0; y < height; y++) {
    // Every row begins with the PNG filter byte 0 (None).
    raw.set(pixels.subarray(y * width, (y + 1) * width), y * stride + 1)
  }
  const header = new Uint8Array(13)
  captchaPngWriteUint32(header, 0, width)
  captchaPngWriteUint32(header, 4, height)
  header[8] = 8 // Eight bits per sample.
  header[9] = 0 // Grayscale, without alpha or interlacing.
  const ihdr = captchaPngChunk('IHDR', header)
  const idat = captchaPngChunk('IDAT', captchaPngDeflateStored(raw))
  const iend = captchaPngChunk('IEND', new Uint8Array(0))
  const png = new Uint8Array(8 + ihdr.length + idat.length + iend.length)
  png.set([137, 80, 78, 71, 13, 10, 26, 10])
  png.set(ihdr, 8)
  png.set(idat, 8 + ihdr.length)
  png.set(iend, 8 + ihdr.length + idat.length)
  return png
}


function apiUrl (methodName, params = null) {
  let query = ''
  if (params) query = '?' + new URLSearchParams(params).toString()
  return `https://api.telegram.org/bot${TOKEN}/${methodName}${query}`
}

function requestTelegram (methodName, body, params = null) {
  return fetch(apiUrl(methodName, params), body).then(r => r.json())
}

function makeReqBody (body) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  }
}

function sendMessage (msg = {}) {
  return requestTelegram('sendMessage', makeReqBody(msg))
}

function copyMessage (msg = {}) {
  return requestTelegram('copyMessage', makeReqBody(msg))
}

function forwardMessage (msg) {
  return requestTelegram('forwardMessage', makeReqBody(msg))
}

function answerCallbackQuery (callbackQueryId, text) {
  const body = { callback_query_id: callbackQueryId }
  if (text) body.text = text
  return requestTelegram('answerCallbackQuery', makeReqBody(body))
}

function deleteMessage (msg) {
  return requestTelegram('deleteMessage', makeReqBody(msg))
}

addEventListener('fetch', event => {
  const url = new URL(event.request.url)
  if (url.pathname === WEBHOOK) {
    event.respondWith(handleWebhook(event))
  } else if (url.pathname === '/registerWebhook') {
    event.respondWith(registerWebhook(event, url, WEBHOOK, SECRET))
  } else if (url.pathname === '/unRegisterWebhook') {
    event.respondWith(unRegisterWebhook(event))
  } else {
    event.respondWith(new Response('No handler for this request', { status: 404 }))
  }
})

async function handleWebhook (event) {
  if (event.request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== SECRET) {
    return new Response('Unauthorized', { status: 403 })
  }

  const update = await event.request.json()
  event.waitUntil(onUpdate(update))
  return new Response('Ok')
}

async function onUpdate (update) {
  if (update.callback_query) {
    await onCallbackQuery(update.callback_query)
  } else if (update.message?.chat?.type === 'private') {
    await onMessage(update.message)
  }
}

async function onMessage (message) {
  const uid = message.from.id.toString()

  if (uid === ADMIN_UID) return handleAdminMessage(message)
  if (await nfd.get('isblocked-' + uid, { type: 'json' })) return
  if (await isTemporarilyRestricted(uid)) return
  if (await isRateLimited(uid)) return

  if (message.text === '/start') {
    const startMsg = await fetch(startMsgUrl).then(r => r.text())
    return sendMessage({ chat_id: message.chat.id, text: startMsg })
  }

  // Replies to captcha images are control messages, even after verification
  // or permanent trust. Never deliver a consumed answer to the administrator.
  if (await handleCaptchaAnswer(message)) return

  const trust = await nfd.get('trusted-' + uid, { type: 'json' })
  if (trust) {
    return handleGuestMessage(message, {
      reason: 'trusted', decidedAt: Date.now(), trustedAt: trust.trustedAt || null
    })
  }
  const verification = await getVerifiedSession(uid)
  if (verification) return handleGuestMessage(message, verificationDeliveryContext('verified_window', verification))

  const fingerprint = await getMessageFingerprint(message)
  if (fingerprint && await nfd.get('spam-fingerprint-' + fingerprint, { type: 'json' })) {
    await silentlyBlockKnownSpam(uid)
    return
  }

  // Greetings and follow-up messages must pass the same gate as media and links.
  // Keep only the first message while the visitor completes verification.
  const pending = await savePendingMessage(message)
  await ensureCaptcha(message, pending)
}

async function getVerifiedSession (uid) {
  const state = await nfd.get('verified-' + uid, { type: 'json' })
  return state?.version === VERIFIED_VERSION && state.method === 'image' &&
    Number.isFinite(state.expiresAt) && state.expiresAt > Date.now() ? state : null
}

async function isVerified (uid) {
  return Boolean(await getVerifiedSession(uid))
}

function verificationDeliveryContext (reason, state) {
  return {
    reason,
    decidedAt: Date.now(),
    verificationMethod: state.method,
    verifiedAt: state.verifiedAt,
    verificationExpiresAt: state.expiresAt
  }
}

async function saveVerificationSession (uid, challengeId) {
  const verifiedAt = Date.now()
  const state = {
    version: VERIFIED_VERSION,
    method: 'image',
    challengeId,
    verifiedAt,
    expiresAt: verifiedAt + VERIFIED_TTL_SECONDS * 1000
  }
  // The fixed timestamp never changes on subsequent visitor messages.
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) await wait(1100)
    try {
      await nfd.put('verified-' + uid, JSON.stringify(state), {
        expirationTtl: VERIFIED_TTL_SECONDS
      })
      return state
    } catch (error) {
      if (attempt === 3) console.error(`verification grant write failed for UID ${uid}: ${error}`)
    }
  }
  return null
}

async function revokeVerificationGrant (uid, grant) {
  const key = 'verified-' + uid
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) await wait(1100)
    try {
      const current = await nfd.get(key, { type: 'json' })
      if (!current || current.version !== grant.version || current.method !== grant.method ||
        current.challengeId !== grant.challengeId || current.verifiedAt !== grant.verifiedAt ||
        current.expiresAt !== grant.expiresAt) return true
      await nfd.delete(key)
      return true
    } catch (_) {
      if (attempt === 3) console.error(`verification rollback failed for UID ${uid}`)
    }
  }
  return false
}

async function revokeVisitorAccess (uid) {
  const keys = ['trusted-', 'verified-', 'captcha-', 'pending-message-']
  const results = await Promise.all(keys.map(async prefix => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (attempt > 1) await wait(1100)
      try {
        await nfd.delete(prefix + uid)
        return true
      } catch (error) {
        if (attempt === 3) console.error(`access revocation failed for ${prefix}${uid}: ${error}`)
      }
    }
    return false
  }))
  return results.every(Boolean)
}

async function handleAdminMessage (message) {
  if (message.text === '/start') {
    const startMsg = await fetch(adminMsgUrl).then(r => r.text())
    return sendMessage({ chat_id: message.chat.id, text: startMsg })
  }
  if (!message?.reply_to_message?.chat) {
    return sendMessage({
      chat_id: ADMIN_UID,
      text: '使用方法，回复转发的消息，并发送回复消息，或者`/block`、`/unblock`、`/checkblock`、`/checkuser`等指令'
    })
  }
  if (/^\/block$/.exec(message.text)) return handleBlock(message)
  if (/^\/unblock$/.exec(message.text)) return handleUnBlock(message)
  if (/^\/checkblock$/.exec(message.text)) return checkBlock(message)
  if (/^\/checkuser$/.exec(message.text)) return checkUser(message)

  const guestChatId = await nfd.get('msg-map-' + message.reply_to_message.message_id, { type: 'json' })
  if (!guestChatId) {
    return sendMessage({ chat_id: ADMIN_UID, text: '找不到该消息对应的用户，无法回复。' })
  }
  const result = await copyMessage({
    chat_id: guestChatId,
    from_chat_id: message.chat.id,
    message_id: message.message_id
  })
  if (result?.ok === true) {
    const trustKey = 'trusted-' + guestChatId
    if (!await nfd.get(trustKey, { type: 'json' })) {
      // /unblock may just have deleted this key. Retry only the KV grant, never
      // the Telegram reply that has already been delivered successfully.
      for (let attempt = 1; attempt <= 3; attempt++) {
        if (attempt > 1) await wait(1100)
        try {
          await nfd.put(trustKey, JSON.stringify({ trustedAt: Date.now() }))
          break
        } catch (error) {
          if (attempt === 3) console.error(`automatic trust write failed for UID ${guestChatId}: ${error}`)
        }
      }
    }
  }
  return result
}

function getMessageText (message) {
  return typeof message.text === 'string'
    ? message.text
    : typeof message.caption === 'string' ? message.caption : ''
}

function normalizeMessageForFingerprint (message) {
  const text = getMessageText(message)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/(?:https?:\/\/|www\.)\S+|(?:t|telegram)\.me\/\S+/gi, ' urltoken ')
    .replace(/@[a-z0-9_]{5,}/gi, ' handletoken ')
    .replace(/\+?\d[\d\s-]{6,}\d/g, ' phonetoken ')
    .replace(/[\p{P}\p{S}\s]+/gu, '')
  return text.length >= 12 ? text : ''
}

async function getMessageFingerprint (message) {
  const normalized = normalizeMessageForFingerprint(message)
  if (!normalized) return null
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

async function silentlyBlockKnownSpam (uid) {
  try {
    await nfd.put('isblocked-' + uid, 'true')
  } catch (error) {
    console.error(`known spam block failed for UID ${uid}: ${error}`)
  }
}

async function hashCaptchaAnswer (uid, challengeId, answer) {
  const digest = await crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode(`nfd:image:${uid}:${challengeId}:${answer}`)
  )
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

async function createCaptcha (userId, chatId, messageId = null, expiresAt = null, pending = null, failures = 0) {
  const now = Date.now()
  const uid = userId.toString()
  const id = crypto.randomUUID()
  const random = crypto.getRandomValues(new Uint8Array(5))
  const answer = Array.from(random, byte => (2 + (byte & 7)).toString()).join('')
  const state = {
    id,
    userId: uid,
    version: CAPTCHA_VERSION,
    method: 'image',
    answerHash: await hashCaptchaAnswer(uid, id, answer),
    failures,
    pendingChatId: pending?.chatId ?? null,
    pendingMessageId: pending?.messageId ?? null,
    pendingExpiresAt: pending?.expiresAt ?? null,
    status: 'active',
    createdAt: now,
    expiresAt: expiresAt || now + CAPTCHA_TTL_SECONDS * 1000,
    writtenAt: null,
    chatId,
    messageId
  }
  // The plaintext exists only while creating the pixels. It is never part of
  // persisted state, a caption, a filename, a callback, a URL, or a log entry.
  return { state, image: renderCaptchaPng(answer) }
}

function captchaText () {
  return '请回复这张图片，输入图片中的 5 位数字。验证会话最多 10 分钟，换图不延长；累计输错 2 次将限制 1 小时。验证通过后首条消息自动发送，等待期间的其他消息请重新发送。'
}

function sendCaptchaPhoto (chatId, image) {
  const form = new FormData()
  form.append('chat_id', chatId.toString())
  form.append('photo', new Blob([image], { type: 'image/png' }), 'captcha.png')
  form.append('caption', captchaText())
  form.append('reply_markup', JSON.stringify({
    force_reply: true,
    input_field_placeholder: '回复图片并输入 5 位数字'
  }))
  return requestTelegram('sendPhoto', { method: 'POST', body: form })
}

function remainingTtl (expiresAt) {
  const seconds = Math.ceil((expiresAt - Date.now()) / 1000)
  // Workers KV requires expirationTtl to be at least 60 seconds. expiresAt remains
  // the authoritative deadline when less than a minute is left.
  return seconds > 0 ? Math.max(60, seconds) : 0
}

async function storeExpiringState (key, state) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) await wait(1100)
    const ttl = remainingTtl(state.expiresAt)
    if (ttl <= 0) return false
    state.writtenAt = Date.now()
    try {
      await nfd.put(key, JSON.stringify(state), { expirationTtl: ttl })
      return true
    } catch (error) {
      if (attempt === 3) console.error(`state write failed for ${key}: ${error}`)
    }
  }
  return false
}

async function savePendingMessage (message, expiresAt = null) {
  const uid = message.from.id.toString()
  const previous = pendingSaveQueues.get(uid) || Promise.resolve()
  const current = previous.then(async () => {
    const key = 'pending-message-' + uid
    const existing = await nfd.get(key, { type: 'json' })
    if (existing && existing.status !== 'completed' && existing.expiresAt > Date.now()) return existing
    if (existing?.status === 'completed') await waitForStateWrite(existing)
    const now = Date.now()
    const pending = {
      chatId: message.chat.id,
      messageId: message.message_id,
      status: 'active',
      writtenAt: now,
      expiresAt: expiresAt || now + CAPTCHA_TTL_SECONDS * 1000
    }
    // A recent /unblock may have deleted this key less than a second ago.
    if (!await storeExpiringState(key, pending)) throw new Error(`pending message write failed for UID ${uid}`)
    return pending
  })
  pendingSaveQueues.set(uid, current)
  try {
    return await current
  } finally {
    if (pendingSaveQueues.get(uid) === current) pendingSaveQueues.delete(uid)
  }
}

function wait (milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

async function waitForStateWrite (state) {
  const elapsed = Date.now() - (state?.writtenAt || state?.createdAt || 0)
  if (elapsed < 1100) await wait(1100 - elapsed)
}

async function waitForCaptchaWrite (state) {
  await waitForStateWrite(state)
}

async function markStateCompleted (key, state, label) {
  if (!state) return false
  await waitForStateWrite(state)
  const completed = {
    status: 'completed',
    version: state.version,
    id: state.id,
    userId: state.userId,
    chatId: state.chatId,
    messageId: state.messageId,
    createdAt: state.createdAt,
    method: state.method,
    failures: state.failures,
    blockedUntil: state.blockedUntil,
    pendingChatId: state.pendingChatId,
    pendingMessageId: state.pendingMessageId,
    pendingExpiresAt: state.pendingExpiresAt,
    completedAt: Date.now(),
    expiresAt: state.expiresAt,
    writtenAt: Date.now()
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) {
      await wait(1100)
      completed.writtenAt = Date.now()
    }
    try {
      const current = await nfd.get(key, { type: 'json' })
      const sameGeneration = current && (state.id
        ? current.id === state.id
        : current.chatId === state.chatId && current.messageId === state.messageId && current.expiresAt === state.expiresAt)
      // State can expire, be revoked, or be replaced during a retry. Never
      // resurrect old records or complete a different pending message.
      if (!sameGeneration) return false
      if (current.status === 'completed' && (current.failures || 0) >= (completed.failures || 0) &&
        (current.blockedUntil || 0) >= (completed.blockedUntil || 0)) return true
      await nfd.put(key, JSON.stringify(completed), {
        expirationTtl: remainingTtl(Math.max(state.expiresAt || 0, state.blockedUntil || 0)) || 60
      })
      return true
    } catch (error) {
      if (attempt === 3) console.error(`${label} completion write failed: ${error}`)
    }
  }
  return false
}

async function sendAndStoreCaptcha (key, challenge, image) {
  if (remainingTtl(challenge.expiresAt) <= 0) return false
  let response
  try {
    response = await sendCaptchaPhoto(challenge.chatId, image)
  } catch (_) {
    console.error(`captcha photo send failed for UID ${challenge.userId}`)
    return false
  }
  if (response?.ok !== true || !Number.isInteger(response.result?.message_id)) return false
  challenge.messageId = response.result.message_id
  const promptSaved = await saveDeliveryRecord(
    `captcha-prompt-${challenge.userId}-${challenge.messageId}`,
    JSON.stringify({ version: 1, uid: challenge.userId, challengeId: challenge.id, createdAt: Date.now() }),
    { expirationTtl: CAPTCHA_PROMPT_TTL_SECONDS }, 'captcha prompt marker'
  )
  if (promptSaved && await storeExpiringState(key, challenge)) return true
  // A prompt without durable identity/state cannot be used. Cleanup only;
  // successful/consumed prompts are retained so late replies keep their context.
  try {
    await deleteMessage({ chat_id: challenge.chatId, message_id: challenge.messageId })
  } catch (_) {
    console.error(`captcha photo cleanup failed for UID ${challenge.userId}`)
  }
  return false
}

async function getCaptchaAttempt (uid, challengeId = null) {
  const attempt = await nfd.get('captcha-attempt-' + uid, { type: 'json' })
  if (!attempt || (challengeId && attempt.challengeId !== challengeId)) return null
  return attempt
}

async function writeCaptchaClaim (state, uid, claimedAt, outcome = {}) {
  const key = 'captcha-attempt-' + uid
  const value = JSON.stringify({
    userId: uid, challengeId: state.id, claimedAt, expiresAt: state.expiresAt,
    failures: outcome.failures ?? state.failures ?? 0,
    outcome: outcome.outcome || 'pending',
    answerMessageId: outcome.answerMessageId || null,
    blockedUntil: outcome.blockedUntil || null
  })
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) await wait(1100)
    try {
      const previous = await getCaptchaAttempt(uid)
      // Re-read before each retry: do not overwrite a consumed generation or
      // shorten a restriction another invocation has already persisted.
      if (previous?.challengeId === state.id || previous?.blockedUntil > Date.now()) return false
      await nfd.put(key, value, {
        expirationTtl: remainingTtl(Math.max(state.expiresAt, outcome.blockedUntil || 0)) || 60
      })
      return true
    } catch (_) {
      if (attempt === 3) console.error(`captcha claim write failed for UID ${uid}`)
    }
  }
  return false
}

async function restrictCaptchaSession (uid, state) {
  const blockedUntil = state.blockedUntil || Date.now() + CAPTCHA_BLOCK_SECONDS * 1000
  const terminal = { ...state, failures: CAPTCHA_MAX_FAILURES, blockedUntil }
  // Keep both the explicit block and the completed session as independent
  // evidence. A failed block write must not reset a consumed two-error session.
  const [blocked, completed] = await Promise.all([
    saveDeliveryRecord('captcha-block-' + uid, JSON.stringify({ blockedUntil }), {
      expirationTtl: remainingTtl(blockedUntil) || 60
    }, 'captcha restriction'),
    markStateCompleted('captcha-' + uid, terminal, `captcha restriction for UID ${uid}`)
  ])
  return blocked || completed
}

async function ensureCaptcha (message, pending = null) {
  const uid = message.from.id.toString()
  const previous = captchaCreationQueues.get(uid) || Promise.resolve()
  const current = previous.catch(() => {}).then(async () => {
    if (await isTemporarilyRestricted(uid)) return
    const key = 'captcha-' + uid
    const existing = await nfd.get(key, { type: 'json' })
    const now = Date.now()
    const currentVersion = existing?.version === CAPTCHA_VERSION && existing.method === 'image'
    const claim = currentVersion && existing.id
      ? await getCaptchaAttempt(uid, existing.id) : null
    const failures = currentVersion && existing.expiresAt > now
      ? Math.max(existing.failures || 0, claim?.failures || 0) : 0
    const blockedUntil = Math.max(existing?.blockedUntil || 0, claim?.blockedUntil || 0)
    if (blockedUntil > now || failures >= CAPTCHA_MAX_FAILURES) {
      await restrictCaptchaSession(uid, { ...existing, failures, blockedUntil: blockedUntil || now + CAPTCHA_BLOCK_SECONDS * 1000 })
      return
    }
    if (currentVersion && existing.status === 'active' && existing.messageId && existing.expiresAt > now) {
      if (!claim || now - claim.claimedAt <= CAPTCHA_PROCESSING_TIMEOUT_MS) return
      await waitForCaptchaWrite(existing)
    } else if (existing?.status === 'completed') {
      await waitForCaptchaWrite(existing)
    }

    const currentPending = pending || await nfd.get('pending-message-' + uid, { type: 'json' })
    const continuesSession = currentVersion && existing.expiresAt > now
    const expiresAt = continuesSession
      ? existing.expiresAt
      : currentPending?.expiresAt > now ? currentPending.expiresAt : now + CAPTCHA_TTL_SECONDS * 1000
    const challenge = await createCaptcha(uid, message.chat.id, null, expiresAt, currentPending, failures)
    if (!await sendAndStoreCaptcha(key, challenge.state, challenge.image)) {
      await sendMessage({ chat_id: message.chat.id, text: '验证码图片暂时无法发送，原消息尚未发送，请稍后重试。' })
    }
  })
  captchaCreationQueues.set(uid, current)
  try {
    return await current
  } finally {
    if (captchaCreationQueues.get(uid) === current) captchaCreationQueues.delete(uid)
  }
}

function isActiveChallenge (state, uid, challengeId = state?.id) {
  return state?.version === CAPTCHA_VERSION && state.method === 'image' &&
    state.id === challengeId && state.userId?.toString() === uid &&
    state.chatId?.toString() === uid && state.status === 'active' &&
    Number.isInteger(state.messageId) && state.messageId > 0 &&
    typeof state.answerHash === 'string' && /^[a-f0-9]{64}$/i.test(state.answerHash) &&
    Number.isFinite(state.expiresAt) && state.expiresAt > Date.now()
}

async function handleCaptchaAnswer (message) {
  const uid = message.from.id.toString()
  const answerKey = `captcha-answer-${uid}-${message.message_id}`
  if (await nfd.get(answerKey, { type: 'json' })) return true
  const replyId = message.reply_to_message?.message_id
  if (!Number.isInteger(replyId)) return false
  const state = await nfd.get('captcha-' + uid, { type: 'json' })
  const currentPrompt = state?.messageId === replyId && state.userId?.toString() === uid && state.chatId?.toString() === uid
  const prompt = currentPrompt || await nfd.get(`captcha-prompt-${uid}-${replyId}`, { type: 'json' })
  if (!prompt) return false
  const previous = captchaAnswerQueues.get(uid) || Promise.resolve()
  const current = previous.catch(() => {}).then(() => processCaptchaAnswer(message))
  captchaAnswerQueues.set(uid, current)
  try {
    await current
  } catch (_) {
    console.error(`captcha answer processing failed for UID ${uid}`)
  } finally {
    if (captchaAnswerQueues.get(uid) === current) captchaAnswerQueues.delete(uid)
  }
  return true
}

async function processCaptchaAnswer (message) {
  const uid = message.from.id.toString()
  if (await nfd.get('isblocked-' + uid, { type: 'json' }) || await isTemporarilyRestricted(uid)) return
  const answerKey = `captcha-answer-${uid}-${message.message_id}`
  if (await nfd.get(answerKey, { type: 'json' })) return
  const stateKey = 'captcha-' + uid
  let state = await nfd.get(stateKey, { type: 'json' })
  if (!isActiveChallenge(state, uid) || state.messageId !== message.reply_to_message?.message_id) {
    await sendMessage({ chat_id: message.chat.id, text: '这张验证码图片已处理或已失效，请勿重复作答；需要验证时请重新发送一条消息获取当前图片。' })
    return
  }
  const answer = typeof message.text === 'string' ? message.text.trim() : ''
  if (!/^[0-9]{5}$/.test(answer)) {
    await sendMessage({ chat_id: message.chat.id, text: '请回复当前验证码图片，只输入图片中的 5 位数字。格式不正确不计入错误次数。' })
    return
  }
  if (await getCaptchaAttempt(uid, state.id)) return
  const correct = await hashCaptchaAnswer(uid, state.id, answer) === state.answerHash
  const failures = (state.failures || 0) + (correct ? 0 : 1)
  const blockedUntil = failures >= CAPTCHA_MAX_FAILURES ? Date.now() + CAPTCHA_BLOCK_SECONDS * 1000 : null
  if (!await saveDeliveryRecord(answerKey, JSON.stringify({
    uid, challengeId: state.id, promptMessageId: state.messageId, receivedAt: Date.now()
  }), { expirationTtl: CAPTCHA_ANSWER_TTL_SECONDS }, 'captcha answer marker')) {
    await sendMessage({ chat_id: message.chat.id, text: '验证暂时无法处理，请稍后重新回复当前图片。' })
    return
  }
  // This lease records the outcome before replacing a wrong image, so retries
  // inherit the same session deadline and failure count. KV is not a global CAS.
  if (!await writeCaptchaClaim(state, uid, Date.now(), {
    outcome: correct ? 'correct' : 'wrong', failures, blockedUntil, answerMessageId: message.message_id
  })) {
    await sendMessage({ chat_id: message.chat.id, text: '验证暂时无法处理，请稍后重新回复当前图片。' })
    return
  }
  const currentState = await nfd.get(stateKey, { type: 'json' })
  if (await nfd.get('isblocked-' + uid, { type: 'json' })) return
  // An accepted second error remains a one-hour restriction even if its
  // original ten-minute challenge expires while the durable receipt is saved.
  if (!correct && failures >= CAPTCHA_MAX_FAILURES) {
    await restrictCaptchaSession(uid, { ...state, failures, blockedUntil })
    await sendMessage({ chat_id: message.chat.id, text: '验证错误次数过多，请 1 小时后再试。' })
    return
  }
  if (!isActiveChallenge(currentState, uid, state.id)) return
  if (await isTemporarilyRestricted(uid)) return
  if (!correct) {
    state = { ...state, failures, blockedUntil }
    await markStateCompleted(stateKey, state, `captcha wrong answer for UID ${uid}`)
    await sendMessage({ chat_id: message.chat.id, text: '验证码不正确，请回复新图片重新输入。再输错一次将限制 1 小时。' })
    await ensureCaptcha(message)
    return
  }

  const grant = await saveVerificationSession(uid, state.id)
  if (!grant) {
    await markStateCompleted(stateKey, state, `captcha state for UID ${uid}`)
    await sendMessage({ chat_id: state.chatId, text: '验证结果保存失败，原消息尚未发送。请重新发送一条消息以再次验证。' })
    return
  }
  if (await nfd.get('isblocked-' + uid, { type: 'json' })) {
    await revokeVisitorAccess(uid)
    return
  }
  if (await isTemporarilyRestricted(uid)) {
    await revokeVerificationGrant(uid, grant)
    return
  }
  if (!isActiveChallenge(await nfd.get(stateKey, { type: 'json' }), uid, state.id)) {
    await revokeVerificationGrant(uid, grant)
    return
  }
  const pendingKey = 'pending-message-' + uid
  const pending = await nfd.get(pendingKey, { type: 'json' })
  const pendingMatches = pending && pending.status !== 'completed' && pending.expiresAt > Date.now() &&
    pending.chatId?.toString() === uid && Number.isInteger(pending.messageId) &&
    state.pendingChatId === pending.chatId && state.pendingMessageId === pending.messageId &&
    state.pendingExpiresAt === pending.expiresAt
  let resultText = '✅ 验证成功，24 小时内可直接发送消息。请发送您的问题。'
  if (pendingMatches) {
    const result = await forwardGuestMessage(
      pending.chatId, pending.messageId, verificationDeliveryContext('verification_pass', grant)
    )
    resultText = result.forwarded
      ? '✅ 验证成功，您的消息已发送，24 小时内可继续发送消息。验证期间的其他消息请重新发送。'
      : '✅ 验证成功，但原消息发送失败，请重新发送一次。'
    if (result.forwarded) {
      try { await handleNotify({ chat: { id: pending.chatId } }) } catch (_) {
        console.error(`fraud notification failed for UID ${uid}`)
      }
    }
  }
  await Promise.allSettled([
    markStateCompleted(stateKey, state, `captcha state for UID ${uid}`),
    pendingMatches ? markStateCompleted(pendingKey, pending, `pending message for UID ${uid}`) : Promise.resolve(false)
  ])
  await sendMessage({ chat_id: state.chatId, text: resultText })
}

async function onCallbackQuery (query) {
  // Legacy buttons only receive an acknowledgement and cannot grant the new
  // image-verification session.
  await answerCallbackQuery(query.id)
}

async function isTemporarilyRestricted (uid) {
  const [captchaBlock, rateBlock, state, claim] = await Promise.all([
    nfd.get('captcha-block-' + uid, { type: 'json' }),
    nfd.get('rate-block-' + uid, { type: 'json' }),
    nfd.get('captcha-' + uid, { type: 'json' }),
    getCaptchaAttempt(uid)
  ])
  const activeCaptchaBlock = captchaBlock === true ||
    (Number.isFinite(captchaBlock?.blockedUntil) && captchaBlock.blockedUntil > Date.now())
  return Boolean(activeCaptchaBlock || rateBlock ||
    (Number.isFinite(state?.blockedUntil) && state.blockedUntil > Date.now()) ||
    (Number.isFinite(claim?.blockedUntil) && claim.blockedUntil > Date.now()))
}

async function isRateLimited (uid) {
  const now = Date.now()
  const minuteWindow = Math.floor(now / 60000)
  const hourWindow = Math.floor(now / 3600000)
  const minuteKey = `rate-minute-${uid}-${minuteWindow}`
  const hourKey = `rate-hour-${uid}-${hourWindow}`
  const [minuteCount, hourCount] = await Promise.all([
    nfd.get(minuteKey, { type: 'json' }),
    nfd.get(hourKey, { type: 'json' })
  ])
  const nextMinuteCount = (minuteCount || 0) + 1
  const nextHourCount = (hourCount || 0) + 1
  try {
    await Promise.all([
      nfd.put(minuteKey, JSON.stringify(nextMinuteCount), { expirationTtl: 120 }),
      nfd.put(hourKey, JSON.stringify(nextHourCount), { expirationTtl: 7200 })
    ])
  } catch (error) {
    // KV limits writes to the same key. Rate limiting is best-effort, so a
    // transient counter failure must not discard a legitimate user message.
    console.error(`rate counter write failed for UID ${uid}: ${error}`)
    return false
  }
  if (nextMinuteCount <= 5 && nextHourCount <= 20) return false

  const strikeKey = `rate-strikes-${uid}`
  const strikeState = await nfd.get(strikeKey, { type: 'json' }) || { windows: [] }
  const recentWindows = strikeState.windows.filter(window => window > minuteWindow - 60)
  const windows = [...new Set(recentWindows)]
  if (!windows.includes(minuteWindow)) windows.push(minuteWindow)

  if (windows.length >= 3) {
    await nfd.put('rate-block-' + uid, 'true', { expirationTtl: RATE_BLOCK_SECONDS })
    await nfd.delete(strikeKey)
  } else {
    await nfd.put(strikeKey, JSON.stringify({ windows }), { expirationTtl: 3600 })
  }
  return true
}

async function handleGuestMessage (message, deliveryContext = { reason: 'unknown' }) {
  const result = await forwardGuestMessage(message.chat.id, message.message_id, deliveryContext)
  if (result.forwarded) return handleNotify(message)
}

async function saveDeliveryRecord (key, value, options, label) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) await wait(1100)
    try {
      await nfd.put(key, value, options)
      return true
    } catch (_) {
      if (attempt === 3) console.error(`${label} write failed after 3 attempts`)
    }
  }
  return false
}

async function forwardGuestMessage (chatId, messageId, deliveryContext = { reason: 'unknown' }) {
  const allowedReasons = ['trusted', 'verified_window', 'verification_pass']
  const reason = allowedReasons.includes(deliveryContext.reason) ? deliveryContext.reason : 'unknown'
  const decidedAt = Number.isFinite(deliveryContext.decidedAt) ? deliveryContext.decidedAt : Date.now()
  let forwardReq
  try {
    forwardReq = await forwardMessage({
      chat_id: ADMIN_UID,
      from_chat_id: chatId,
      message_id: messageId
    })
  } catch (_) {
    console.error(`forwardMessage failed for UID ${chatId}`)
    return { forwarded: false, mapped: false, audited: false, adminMessageId: null }
  }
  const adminMessageId = forwardReq?.result?.message_id
  if (forwardReq?.ok !== true || !Number.isInteger(adminMessageId)) {
    return { forwarded: false, mapped: false, audited: false, adminMessageId: null }
  }
  const audit = {
    version: 1,
    uid: chatId.toString(),
    sourceMessageId: messageId,
    adminMessageId,
    reason,
    decidedAt,
    deliveredAt: Date.now(),
    verificationMethod: deliveryContext.verificationMethod === 'image' ? 'image' : null,
    verifiedAt: Number.isFinite(deliveryContext.verifiedAt) ? deliveryContext.verifiedAt : null,
    verificationExpiresAt: Number.isFinite(deliveryContext.verificationExpiresAt) ? deliveryContext.verificationExpiresAt : null,
    trustedAt: Number.isFinite(deliveryContext.trustedAt) ? deliveryContext.trustedAt : null
  }
  // Mapping and historical evidence are separate writes. Failure of either
  // never retries Telegram delivery and therefore never duplicates the message.
  const [mapped, audited] = await Promise.all([
    saveDeliveryRecord('msg-map-' + adminMessageId, chatId.toString(), undefined, `mapping for ${adminMessageId}`),
    saveDeliveryRecord('delivery-audit-' + adminMessageId, JSON.stringify(audit), {
      expirationTtl: DELIVERY_AUDIT_TTL_SECONDS
    }, `delivery audit for ${adminMessageId}`)
  ])
  console.log(JSON.stringify({ event: 'message_delivered', uid: audit.uid, sourceMessageId: messageId, adminMessageId, reason, mapped, audited }))
  return { forwarded: true, mapped, audited, adminMessageId }
}

async function handleNotify (message) {
  const chatId = message.chat.id
  if (await isFraud(chatId)) {
    return sendMessage({ chat_id: ADMIN_UID, text: `检测到骗子，UID${chatId}` })
  }
}

async function handleBlock (message) {
  const guestChatId = await nfd.get('msg-map-' + message.reply_to_message.message_id, { type: 'json' })
  if (!guestChatId) return sendMessage({ chat_id: ADMIN_UID, text: '找不到该消息对应的用户，无法屏蔽。' })
  if (guestChatId?.toString() === ADMIN_UID) return sendMessage({ chat_id: ADMIN_UID, text: '不能屏蔽自己' })
  const fingerprint = await getMessageFingerprint(message.reply_to_message)
  const writes = [nfd.put('isblocked-' + guestChatId, 'true')]
  if (fingerprint) {
    writes.push(nfd.put('spam-fingerprint-' + fingerprint, JSON.stringify({
      sourceUid: guestChatId.toString(),
      blockedAt: Date.now()
    }), { expirationTtl: SPAM_FINGERPRINT_TTL_SECONDS }))
  }
  await Promise.all(writes)
  const revoked = await revokeVisitorAccess(guestChatId)
  return sendMessage({
    chat_id: ADMIN_UID,
    text: `UID:${guestChatId}屏蔽成功${fingerprint ? '，已记录广告特征' : ''}${revoked ? '' : '；资格清理失败，解除屏蔽前将重试清理'}`
  })
}

async function handleUnBlock (message) {
  const guestChatId = await nfd.get('msg-map-' + message.reply_to_message.message_id, { type: 'json' })
  if (!guestChatId) return sendMessage({ chat_id: ADMIN_UID, text: '找不到该消息对应的用户，无法解除屏蔽。' })
  // Never restore a verification grant or trust record left behind by a failed
  // revocation. A newly unblocked visitor must verify again.
  if (!await revokeVisitorAccess(guestChatId)) {
    return sendMessage({ chat_id: ADMIN_UID, text: '信任或验证状态清理失败，未解除屏蔽，请稍后重试。' })
  }
  await nfd.put('isblocked-' + guestChatId, 'false')
  const fingerprint = await getMessageFingerprint(message.reply_to_message)
  if (fingerprint) await nfd.delete('spam-fingerprint-' + fingerprint)
  return sendMessage({ chat_id: ADMIN_UID, text: `UID:${guestChatId}解除屏蔽成功` })
}

async function checkBlock (message) {
  const guestChatId = await nfd.get('msg-map-' + message.reply_to_message.message_id, { type: 'json' })
  if (!guestChatId) return sendMessage({ chat_id: ADMIN_UID, text: '找不到该消息对应的用户。' })
  const blocked = await nfd.get('isblocked-' + guestChatId, { type: 'json' })
  return sendMessage({ chat_id: ADMIN_UID, text: `UID:${guestChatId}${blocked ? '被屏蔽' : '没有被屏蔽'}` })
}

function formatAuditTime (timestamp) {
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : '未知'
}

async function checkUser (message) {
  const adminMessageId = message.reply_to_message.message_id
  const [mapping, storedAudit] = await Promise.all([
    nfd.get('msg-map-' + adminMessageId, { type: 'json' }),
    nfd.get('delivery-audit-' + adminMessageId, { type: 'json' })
  ])
  const audit = storedAudit?.version === 1 && storedAudit.adminMessageId === adminMessageId &&
    typeof storedAudit.uid === 'string' && /^[1-9]\d*$/.test(storedAudit.uid) ? storedAudit : null
  const uid = mapping ? mapping.toString() : audit?.uid
  if (!uid) return sendMessage({ chat_id: ADMIN_UID, text: '找不到该消息对应的用户，也没有可用的投递记录。' })
  const [blocked, temporary, trust, verification] = await Promise.all([
    nfd.get('isblocked-' + uid, { type: 'json' }),
    isTemporarilyRestricted(uid),
    nfd.get('trusted-' + uid, { type: 'json' }),
    getVerifiedSession(uid)
  ])
  const history = audit?.uid === uid ? audit : null
  const reasons = {
    trusted: '永久信任名单内',
    verified_window: '24 小时验证有效期内',
    verification_pass: '本次图片验证码通过',
    unknown: '未知'
  }
  const lines = [`UID:${uid}`]
  if (history) {
    lines.push(`这条消息当时的投递原因：${reasons[history.reason] || '未知'}`)
    lines.push(`投递时间：${formatAuditTime(history.deliveredAt)}`)
    if (history.verificationMethod) lines.push(`当时验证方式：${history.verificationMethod}`)
    if (history.verifiedAt) lines.push(`当时验证时间：${formatAuditTime(history.verifiedAt)}`)
    if (history.verificationExpiresAt) lines.push(`当时验证到期：${formatAuditTime(history.verificationExpiresAt)}`)
    if (history.trustedAt) lines.push(`当时信任时间：${formatAuditTime(history.trustedAt)}`)
  } else {
    lines.push('这条消息当时的投递原因：未知（旧消息、记录已过期或当时未能保存）')
  }
  lines.push(`当前封禁：${blocked ? '已永久屏蔽' : '未屏蔽'}`)
  lines.push(`当前临时限制：${temporary ? '限制中' : '无'}`)
  lines.push(`当前永久信任：${trust ? `已信任，信任时间 ${formatAuditTime(trust.trustedAt)}` : '未信任'}`)
  lines.push(`当前验证资格：${verification ? `验证有效，直到 ${formatAuditTime(verification.expiresAt)}` : '未验证或已过期'}`)
  return sendMessage({ chat_id: ADMIN_UID, text: lines.join('\n') })
}

function rejectManagementRequest (request) {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } })
  }
  if (request.headers.get('Authorization') !== `Bearer ${SECRET}`) {
    return new Response('Unauthorized', { status: 401 })
  }
  return null
}

async function registerWebhook (event, requestUrl, suffix, secret) {
  const rejection = rejectManagementRequest(event.request)
  if (rejection) return rejection
  const webhookUrl = `${requestUrl.origin}${suffix}`
  const r = await (await fetch(apiUrl('setWebhook', { url: webhookUrl, secret_token: secret }))).json()
  return new Response('ok' in r && r.ok ? 'Ok' : JSON.stringify(r, null, 2))
}

async function unRegisterWebhook (event) {
  const rejection = rejectManagementRequest(event.request)
  if (rejection) return rejection
  const r = await (await fetch(apiUrl('setWebhook', { url: '' }))).json()
  return new Response('ok' in r && r.ok ? 'Ok' : JSON.stringify(r, null, 2))
}

async function isFraud (id) {
  id = id.toString()
  const db = await fetch(fraudDb).then(r => r.text())
  const arr = db.split('\n').filter(v => v)
  return arr.includes(id)
}

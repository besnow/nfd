const TOKEN = ENV_BOT_TOKEN // Get it from @BotFather
const WEBHOOK = '/endpoint'
const SECRET = ENV_BOT_SECRET // A-Z, a-z, 0-9, _ and -
const ADMIN_UID = ENV_ADMIN_UID.toString() // your user id, get it from https://t.me/username_to_id_bot

const CAPTCHA_TTL_SECONDS = 10 * 60
const CAPTCHA_PROCESSING_TIMEOUT_MS = 30 * 1000
const CAPTCHA_VERSION = 3
const VERIFIED_VERSION = 4
const VERIFIED_TTL_SECONDS = 24 * 60 * 60
const SPAM_FINGERPRINT_TTL_SECONDS = 30 * 24 * 60 * 60
const RATE_BLOCK_SECONDS = 24 * 60 * 60
const DELIVERY_AUDIT_TTL_SECONDS = 30 * 24 * 60 * 60
const TURNSTILE_ACTION = 'nfd_verify'
const INIT_DATA_MAX_AGE_SECONDS = 10 * 60
const VERIFY_BODY_MAX_BYTES = 16384
const CHALLENGE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TURNSTILE_SITE_KEY = typeof ENV_TURNSTILE_SITE_KEY === 'string' ? ENV_TURNSTILE_SITE_KEY.trim() : ''
const TURNSTILE_SECRET_KEY = typeof ENV_TURNSTILE_SECRET_KEY === 'string' ? ENV_TURNSTILE_SECRET_KEY.trim() : ''
const PUBLIC_URL = typeof ENV_PUBLIC_URL === 'string' ? ENV_PUBLIC_URL.trim() : ''
const fraudDb = 'https://raw.githubusercontent.com/LloydAsp/nfd/main/data/fraud.db'
const startMsgUrl = 'https://raw.githubusercontent.com/besnow/nfd/main/data/startMessage.v4.md'
const adminMsgUrl = 'https://raw.githubusercontent.com/besnow/nfd/main/data/adminMessage.v4.md'

const pendingSaveQueues = new Map()
const captchaCreationQueues = new Map()
const verificationQueues = new Map()

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
  if (url.pathname === '/verify') {
    event.respondWith(handleVerifyPage(event.request))
  } else if (url.pathname === '/verify/complete') {
    event.respondWith(handleVerifyComplete(event.request))
  } else if (url.pathname === WEBHOOK) {
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
  return state?.version === VERIFIED_VERSION && state.method === 'turnstile' &&
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
    method: 'turnstile',
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

function getVerificationConfig () {
  if (!TURNSTILE_SITE_KEY || !TURNSTILE_SECRET_KEY || !PUBLIC_URL) return null
  try {
    const url = new URL(PUBLIC_URL)
    if (url.protocol !== 'https:' || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) return null
    return {
      siteKey: TURNSTILE_SITE_KEY,
      secretKey: TURNSTILE_SECRET_KEY,
      origin: url.origin,
      hostname: url.hostname
    }
  } catch (_) {
    return null
  }
}

function createCaptcha (userId, chatId, messageId = null, expiresAt = null, pending = null) {
  const now = Date.now()
  return {
    id: crypto.randomUUID(),
    userId: userId.toString(),
    version: CAPTCHA_VERSION,
    method: 'turnstile',
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
}

function captchaText () {
  return '为防止自动广告，请点击下方按钮完成安全验证。验证通过后，首条消息会自动发送；等待期间的其他消息请在通过后重新发送。'
}

function captchaKeyboard (challenge, config) {
  const url = new URL('/verify', config.origin)
  url.searchParams.set('challenge', challenge.id)
  return { inline_keyboard: [[{ text: '开始安全验证', web_app: { url: url.toString() } }]] }
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
      if (current.status === 'completed') return true
      await nfd.put(key, JSON.stringify(completed), {
        expirationTtl: remainingTtl(state.expiresAt) || 60
      })
      return true
    } catch (error) {
      if (attempt === 3) console.error(`${label} completion write failed: ${error}`)
    }
  }
  return false
}

async function sendAndStoreCaptcha (key, challenge) {
  const config = getVerificationConfig()
  if (!config || remainingTtl(challenge.expiresAt) <= 0) return false
  const response = await sendMessage({
    chat_id: challenge.chatId,
    text: captchaText(challenge),
    reply_markup: captchaKeyboard(challenge, config)
  })
  if (response?.ok !== true || !response.result?.message_id) return false
  const ttl = remainingTtl(challenge.expiresAt)
  if (ttl <= 0) {
    await deleteMessage({ chat_id: challenge.chatId, message_id: response.result.message_id })
    return false
  }
  challenge.messageId = response.result.message_id
  if (!await storeExpiringState(key, challenge)) {
    try {
      const deleted = await deleteMessage({ chat_id: challenge.chatId, message_id: challenge.messageId })
      if (deleted?.ok !== true) {
        console.error(`captcha cleanup delete failed for UID ${challenge.userId}, message ${challenge.messageId}`)
      }
    } catch (deleteError) {
      console.error(`captcha cleanup delete failed for UID ${challenge.userId}, message ${challenge.messageId}: ${deleteError}`)
    }
    return false
  }
  return true
}

async function writeCaptchaClaim (state, uid, claimedAt) {
  const key = 'captcha-claim-' + state.id
  const value = JSON.stringify({ userId: uid, claimedAt })
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) await wait(1100)
    try {
      await nfd.put(key, value, { expirationTtl: remainingTtl(state.expiresAt) || 60 })
      return true
    } catch (error) {
      if (attempt === 3) {
        console.error(`captcha claim write failed after 3 attempts for UID ${uid}, challenge ${state.id}: ${error}`)
      }
    }
  }
  return false
}

async function ensureCaptcha (message, pending = null) {
  const uid = message.from.id.toString()
  if (!getVerificationConfig()) {
    await sendMessage({ chat_id: message.chat.id, text: '安全验证暂不可用，消息尚未发送，请稍后重试。' })
    return
  }
  const previous = captchaCreationQueues.get(uid) || Promise.resolve()
  const current = previous.then(async () => {
    const key = 'captcha-' + uid
    const existing = await nfd.get(key, { type: 'json' })
    const now = Date.now()
    if (existing?.version === CAPTCHA_VERSION && existing.method === 'turnstile' && existing.status === 'active' && existing.messageId && existing.expiresAt > now) {
      const claim = await nfd.get('captcha-claim-' + existing.id, { type: 'json' })
      if (!claim || now - claim.claimedAt <= CAPTCHA_PROCESSING_TIMEOUT_MS) return
      await waitForCaptchaWrite(existing)
    } else if (existing?.status === 'completed') {
      await waitForCaptchaWrite(existing)
    }

    const currentPending = pending || await nfd.get('pending-message-' + uid, { type: 'json' })
    const continuesActiveSession = existing?.status === 'active' && existing.expiresAt > now
    const expiresAt = continuesActiveSession
      ? existing.expiresAt
      : currentPending?.expiresAt > now ? currentPending.expiresAt : now + CAPTCHA_TTL_SECONDS * 1000
    const challenge = createCaptcha(uid, message.chat.id, null, expiresAt, currentPending)
    await sendAndStoreCaptcha(key, challenge)
  })
  captchaCreationQueues.set(uid, current)
  try {
    await current
  } finally {
    if (captchaCreationQueues.get(uid) === current) captchaCreationQueues.delete(uid)
  }
}

function verifyResponse (status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders
    }
  })
}

function isVerificationOrigin (request, config) {
  try {
    return new URL(request.url).origin === config.origin &&
      (!request.headers.get('Origin') || request.headers.get('Origin') === config.origin)
  } catch (_) {
    return false
  }
}

async function hmacSha256 (key, value) {
  const encoder = new TextEncoder()
  const imported = await crypto.subtle.importKey(
    'raw', typeof key === 'string' ? encoder.encode(key) : key,
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  )
  return new Uint8Array(await crypto.subtle.sign('HMAC', imported, encoder.encode(value)))
}

async function validateTelegramInitData (raw) {
  if (typeof raw !== 'string' || !raw || raw.length > 8192) return null
  try {
    const params = new URLSearchParams(raw)
    const seen = new Set()
    const fields = []
    for (const [key, value] of params) {
      if (seen.has(key)) return null
      seen.add(key)
      if (key !== 'hash') fields.push([key, value])
    }
    const hash = params.get('hash')
    if (!hash || !/^[a-f0-9]{64}$/i.test(hash)) return null
    fields.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    // HMAC validation excludes hash only. Telegram's optional signature remains
    // part of this string (the Ed25519 validation rules are different).
    const dataCheckString = fields.map(([key, value]) => `${key}=${value}`).join('\n')
    const secretKey = await hmacSha256('WebAppData', TOKEN)
    const expected = await hmacSha256(secretKey, dataCheckString)
    const supplied = new Uint8Array(hash.match(/../g).map(byte => parseInt(byte, 16)))
    let difference = 0
    for (let index = 0; index < expected.length; index++) difference |= expected[index] ^ supplied[index]
    if (difference !== 0) return null

    const authDateRaw = params.get('auth_date')
    if (!authDateRaw || !/^\d{1,12}$/.test(authDateRaw)) return null
    const authDate = Number(authDateRaw)
    const now = Math.floor(Date.now() / 1000)
    if (!Number.isSafeInteger(authDate) || now - authDate > INIT_DATA_MAX_AGE_SECONDS || authDate - now > 30) return null
    const user = JSON.parse(params.get('user'))
    if (!user || typeof user !== 'object' || Array.isArray(user) ||
      !Number.isSafeInteger(user.id) || user.id <= 0 || user.is_bot === true) return null
    return { userId: user.id.toString(), authDate }
  } catch (_) {
    return null
  }
}

async function readVerifyBody (request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') || '')) throw new Error('invalid content type')
  if (!request.body) throw new Error('missing body')
  const reader = request.body.getReader()
  const chunks = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > VERIFY_BODY_MAX_BYTES) {
        await reader.cancel()
        throw new Error('body too large')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid body')
  return body
}

async function verifyTurnstileToken (token, challengeId, request, config = getVerificationConfig()) {
  if (!config || typeof token !== 'string' || !token || token.length > 2048) return false
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10000)
  try {
    const body = { secret: config.secretKey, response: token }
    const ip = request.headers.get('CF-Connecting-IP')
    if (ip) body.remoteip = ip
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    })
    if (!response.ok) return false
    const result = await response.json()
    return result?.success === true && result.hostname === config.hostname &&
      result.action === TURNSTILE_ACTION && result.cdata === challengeId
  } catch (_) {
    // Never log the submitted token, signed Telegram data, or secret.
    console.error('Turnstile verification request failed')
    return false
  } finally {
    clearTimeout(timeout)
  }
}

function isActiveChallenge (state, uid, challengeId) {
  return state?.version === CAPTCHA_VERSION && state.method === 'turnstile' &&
    state.id === challengeId && state.userId?.toString() === uid &&
    state.chatId?.toString() === uid && state.status === 'active' &&
    Number.isInteger(state.messageId) && state.messageId > 0 &&
    Number.isFinite(state.expiresAt) && state.expiresAt > Date.now()
}

async function completeVerification (request, config, uid, body) {
  if (uid === ADMIN_UID || await nfd.get('isblocked-' + uid, { type: 'json' }) || await isTemporarilyRestricted(uid)) {
    return verifyResponse(403, { ok: false, error: 'blocked' })
  }
  const stateKey = 'captcha-' + uid
  let state = await nfd.get(stateKey, { type: 'json' })
  if (!isActiveChallenge(state, uid, body.challengeId)) return verifyResponse(409, { ok: false, error: 'invalid_challenge' })
  if (await nfd.get('captcha-claim-' + state.id, { type: 'json' })) {
    return verifyResponse(409, { ok: false, error: 'already_processing' })
  }
  if (!await verifyTurnstileToken(body.turnstileToken, state.id, request, config)) {
    return verifyResponse(403, { ok: false, error: 'turnstile_failed' })
  }

  // Siteverify may take time. Re-read identity-bound state and restrictions
  // before claiming the attempt; never trust stale browser-supplied state.
  state = await nfd.get(stateKey, { type: 'json' })
  if (!isActiveChallenge(state, uid, body.challengeId)) return verifyResponse(409, { ok: false, error: 'invalid_challenge' })
  if (await nfd.get('isblocked-' + uid, { type: 'json' }) || await isTemporarilyRestricted(uid)) {
    return verifyResponse(403, { ok: false, error: 'blocked' })
  }
  if (await nfd.get('captcha-claim-' + state.id, { type: 'json' })) {
    return verifyResponse(409, { ok: false, error: 'already_processing' })
  }
  // Persist a recovery lease before consuming the Telegram button. A failed
  // claim leaves the button usable; an abandoned lease can be renewed by
  // ensureCaptcha after 30 seconds. KV/deleteMessage are best-effort deduplication,
  // not a cross-instance atomic transaction.
  if (!await writeCaptchaClaim(state, uid, Date.now())) {
    return verifyResponse(503, { ok: false, error: 'verification_unavailable' })
  }
  if (!isActiveChallenge(await nfd.get(stateKey, { type: 'json' }), uid, state.id)) {
    return verifyResponse(409, { ok: false, error: 'invalid_challenge' })
  }
  if (await nfd.get('isblocked-' + uid, { type: 'json' }) || await isTemporarilyRestricted(uid)) {
    return verifyResponse(403, { ok: false, error: 'blocked' })
  }
  let deleted
  try {
    deleted = await deleteMessage({ chat_id: state.chatId, message_id: state.messageId })
  } catch (_) {
    return verifyResponse(503, { ok: false, error: 'verification_unavailable' })
  }
  if (deleted?.ok !== true) return verifyResponse(409, { ok: false, error: 'already_processing' })
  if (!isActiveChallenge(await nfd.get(stateKey, { type: 'json' }), uid, state.id)) {
    return verifyResponse(409, { ok: false, error: 'invalid_challenge' })
  }
  if (await nfd.get('isblocked-' + uid, { type: 'json' }) || await isTemporarilyRestricted(uid)) {
    return verifyResponse(403, { ok: false, error: 'blocked' })
  }

  const grant = await saveVerificationSession(uid, state.id)
  if (!grant) {
    await markStateCompleted(stateKey, state, `captcha state for UID ${uid}`)
    await sendMessage({
      chat_id: state.chatId,
      text: '验证结果保存失败，原消息尚未发送。请重新发送一条消息以再次验证。'
    })
    return verifyResponse(503, { ok: false, error: 'verification_unavailable' })
  }
  if (await nfd.get('isblocked-' + uid, { type: 'json' })) {
    await revokeVisitorAccess(uid)
    return verifyResponse(403, { ok: false, error: 'blocked' })
  }
  if (await isTemporarilyRestricted(uid)) {
    await revokeVerificationGrant(uid, grant)
    return verifyResponse(403, { ok: false, error: 'blocked' })
  }
  if (!isActiveChallenge(await nfd.get(stateKey, { type: 'json' }), uid, state.id)) {
    await revokeVerificationGrant(uid, grant)
    return verifyResponse(409, { ok: false, error: 'invalid_challenge' })
  }
  const pendingKey = 'pending-message-' + uid
  const pending = await nfd.get(pendingKey, { type: 'json' })
  const pendingMatches = pending && pending.status !== 'completed' && pending.expiresAt > Date.now() &&
    pending.chatId?.toString() === uid && Number.isInteger(pending.messageId) &&
    state.pendingChatId === pending.chatId && state.pendingMessageId === pending.messageId &&
    state.pendingExpiresAt === pending.expiresAt
  let forwarded = false
  let resultText = '✅ 验证成功，24 小时内可直接发送消息。请发送您的问题。'
  if (pendingMatches) {
    const forwardResult = await forwardGuestMessage(
      pending.chatId, pending.messageId, verificationDeliveryContext('verification_pass', grant)
    )
    forwarded = forwardResult.forwarded
    resultText = forwarded
      ? '✅ 验证成功，您的消息已发送，24 小时内可继续发送消息。验证期间的其他消息请重新发送。'
      : '✅ 验证成功，但原消息发送失败，请重新发送一次。'
    if (forwarded) {
      try {
        await handleNotify({ chat: { id: pending.chatId } })
      } catch (_) {
        console.error(`fraud notification failed for UID ${uid}`)
      }
    }
  }
  await Promise.allSettled([
    markStateCompleted(stateKey, state, `captcha state for UID ${uid}`),
    pendingMatches ? markStateCompleted(pendingKey, pending, `pending message for UID ${uid}`) : Promise.resolve(false)
  ])
  await sendMessage({ chat_id: state.chatId, text: resultText })
  return verifyResponse(200, { ok: true, status: 'verified', forwarded })
}

async function handleVerifyComplete (request) {
  if (request.method !== 'POST') return verifyResponse(405, { ok: false, error: 'method_not_allowed' }, { Allow: 'POST' })
  const config = getVerificationConfig()
  if (!config) return verifyResponse(503, { ok: false, error: 'verification_unavailable' })
  if (!isVerificationOrigin(request, config)) return verifyResponse(403, { ok: false, error: 'invalid_origin' })
  let body
  try {
    body = await readVerifyBody(request)
  } catch (_) {
    return verifyResponse(400, { ok: false, error: 'malformed_request' })
  }
  if (typeof body.initData !== 'string' || !body.initData || body.initData.length > 8192 ||
    typeof body.challengeId !== 'string' || !CHALLENGE_ID_PATTERN.test(body.challengeId) ||
    typeof body.turnstileToken !== 'string' || !body.turnstileToken || body.turnstileToken.length > 2048) {
    return verifyResponse(400, { ok: false, error: 'malformed_request' })
  }
  const identity = await validateTelegramInitData(body.initData)
  if (!identity) return verifyResponse(401, { ok: false, error: 'invalid_identity' })
  const previous = verificationQueues.get(body.challengeId) || Promise.resolve()
  const current = previous.catch(() => {}).then(() => completeVerification(request, config, identity.userId, body))
  verificationQueues.set(body.challengeId, current)
  try {
    return await current
  } catch (_) {
    console.error('Verification completion failed')
    return verifyResponse(503, { ok: false, error: 'verification_unavailable' })
  } finally {
    if (verificationQueues.get(body.challengeId) === current) verificationQueues.delete(body.challengeId)
  }
}

function handleVerifyPage (request) {
  if (request.method !== 'GET') return verifyResponse(405, { ok: false, error: 'method_not_allowed' }, { Allow: 'GET' })
  const config = getVerificationConfig()
  if (!config) return verifyResponse(503, { ok: false, error: 'verification_unavailable' })
  if (!isVerificationOrigin(request, config)) return verifyResponse(403, { ok: false, error: 'invalid_origin' })
  const params = new URL(request.url).searchParams
  const challengeId = params.get('challenge')
  if (params.getAll('challenge').length !== 1 || !challengeId || !CHALLENGE_ID_PATTERN.test(challengeId)) {
    return verifyResponse(400, { ok: false, error: 'malformed_request' })
  }
  const nonce = crypto.randomUUID().replace(/-/g, '')
  const pageConfig = JSON.stringify({ siteKey: config.siteKey, challengeId, action: TURNSTILE_ACTION }).replace(/</g, '\\u003c')
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>安全验证</title>
<style nonce="${nonce}">:root{color-scheme:light dark}body{margin:0;padding:28px 18px;font:16px/1.6 system-ui,sans-serif;background:#f5f7fb;color:#152238}main{max-width:420px;margin:24px auto;padding:26px;background:#fff;border-radius:16px}h1{font-size:23px;margin:0 0 12px}p{color:#526177}#widget{min-height:75px;margin:20px 0}button{padding:11px 18px;border:0;border-radius:9px;background:#2463eb;color:#fff;font:inherit;cursor:pointer}button[hidden]{display:none}@media(prefers-color-scheme:dark){body{background:#121824;color:#edf2fc}main{background:#1c2636}p{color:#b1bfd5}}</style>
<script nonce="${nonce}" src="https://telegram.org/js/telegram-web-app.js"></script></head>
<body><main><h1>安全验证</h1><p>完成验证后，回到机器人即可继续交流。</p><div id="widget"></div><p id="status" role="status">正在加载验证…</p><button id="retry" hidden>重新验证</button><button id="close" hidden>返回机器人</button></main>
<script nonce="${nonce}">
'use strict';
const config = ${pageConfig};
const app = window.Telegram && window.Telegram.WebApp;
const initData = app && app.initData;
const statusNode = document.getElementById('status');
const retryButton = document.getElementById('retry');
const closeButton = document.getElementById('close');
let widgetId;
let busy = false;
let turnstileReady = false;
function showError(text) { statusNode.textContent = text; retryButton.hidden = widgetId === undefined; }
retryButton.addEventListener('click', () => { if (!busy && widgetId !== undefined) { retryButton.hidden = true; statusNode.textContent = '请完成安全验证。'; window.turnstile.reset(widgetId); } });
closeButton.addEventListener('click', () => { if (app) app.close(); });
if (app) { app.ready(); app.expand(); }
setTimeout(function () {
  if (!turnstileReady) {
    showError('验证服务加载失败，请检查网络后回到机器人重新打开。');
    closeButton.hidden = !app;
  }
}, 15000);
window.onTurnstileReady = function () {
  turnstileReady = true;
  if (!initData) { showError('请关闭本页，在 Telegram 机器人中点击“开始安全验证”重新打开。'); return; }
  statusNode.textContent = '请完成安全验证。';
  widgetId = window.turnstile.render('#widget', {
    sitekey: config.siteKey, action: config.action, cData: config.challengeId,
    callback: async function (token) {
      if (busy) return;
      busy = true; retryButton.hidden = true; statusNode.textContent = '正在确认验证结果…';
      try {
        const response = await fetch('/verify/complete', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({initData:initData,challengeId:config.challengeId,turnstileToken:token}) });
        const result = await response.json();
        if (!response.ok || !result.ok) {
          const messages = {invalid_identity:'身份信息已过期，请回到机器人重新打开验证。',invalid_challenge:'验证入口已过期或已使用，请回到机器人重新发送消息。',already_processing:'验证正在处理或入口已使用，请稍后返回机器人；需要时重新发送消息。',blocked:'当前账号暂时无法发送消息。',verification_unavailable:'验证暂时不可用，请回到机器人重新发送消息后再试。'};
          showError(messages[result.error] || '安全验证未通过，请重试。');
          return;
        }
        statusNode.textContent = result.forwarded ? '验证完成，首条消息已发送。等待期间的其他消息，请回到机器人重新发送。' : '验证完成，请回到机器人发送您的消息。';
        closeButton.hidden = false;
      } catch (_) { showError('连接失败，请重试；如果已经收到验证成功提示，可直接返回机器人。'); }
      finally { busy = false; }
    },
    'error-callback': function () { showError('验证服务暂时不可用，请重试。'); },
    'expired-callback': function () { showError('验证已过期，请重新验证。'); }
  });
};
</script><script nonce="${nonce}" src="https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onTurnstileReady&amp;render=explicit" async defer></script></body></html>`
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}' https://telegram.org https://challenges.cloudflare.com; style-src 'unsafe-inline'; frame-src https://challenges.cloudflare.com; connect-src 'self' https://challenges.cloudflare.com; img-src data: https://challenges.cloudflare.com; base-uri 'none'; form-action 'none'`
    }
  })
}

async function onCallbackQuery (query) {
  // Legacy emoji buttons only receive an acknowledgement. They can never grant
  // the new verification session, including challenges left over after rollout.
  await answerCallbackQuery(query.id)
}

async function isTemporarilyRestricted (uid) {
  return Boolean(
    await nfd.get('captcha-block-' + uid, { type: 'json' }) ||
    await nfd.get('rate-block-' + uid, { type: 'json' })
  )
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
    verificationMethod: deliveryContext.verificationMethod === 'turnstile' ? 'turnstile' : null,
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
    verification_pass: '本次 Turnstile 安全验证通过',
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

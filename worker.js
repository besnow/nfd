const TOKEN = ENV_BOT_TOKEN // Get it from @BotFather
const WEBHOOK = '/endpoint'
const SECRET = ENV_BOT_SECRET // A-Z, a-z, 0-9, _ and -
const ADMIN_UID = ENV_ADMIN_UID.toString() // your user id, get it from https://t.me/username_to_id_bot

const CAPTCHA_TTL_SECONDS = 10 * 60
const CAPTCHA_PROCESSING_TIMEOUT_MS = 30 * 1000
const CAPTCHA_BLOCK_SECONDS = 60 * 60
const CAPTCHA_ROUNDS = 2
const CAPTCHA_MAX_FAILURES = 2
const CAPTCHA_VERSION = 2
const VERIFIED_VERSION = 3
const VERIFIED_TTL_SECONDS = 24 * 60 * 60
const SPAM_FINGERPRINT_TTL_SECONDS = 30 * 24 * 60 * 60
const RATE_BLOCK_SECONDS = 24 * 60 * 60
const fraudDb = 'https://raw.githubusercontent.com/LloydAsp/nfd/main/data/fraud.db'
const startMsgUrl = 'https://raw.githubusercontent.com/besnow/nfd/main/data/startMessage.md'
const adminMsgUrl = 'https://raw.githubusercontent.com/besnow/nfd/main/data/adminMessage.md'

const pendingSaveQueues = new Map()
const captchaCreationQueues = new Map()

const CAPTCHA_ICONS = [
  { label: '苹果', icon: '🍎' }, { label: '香蕉', icon: '🍌' },
  { label: '葡萄', icon: '🍇' }, { label: '西瓜', icon: '🍉' },
  { label: '草莓', icon: '🍓' }, { label: '樱桃', icon: '🍒' },
  { label: '汉堡', icon: '🍔' }, { label: '披萨', icon: '🍕' },
  { label: '蛋糕', icon: '🍰' }, { label: '足球', icon: '⚽' },
  { label: '篮球', icon: '🏀' }, { label: '汽车', icon: '🚗' },
  { label: '公交车', icon: '🚌' }, { label: '飞机', icon: '✈️' },
  { label: '火箭', icon: '🚀' }, { label: '房子', icon: '🏠' },
  { label: '太阳', icon: '☀️' }, { label: '月亮', icon: '🌙' },
  { label: '星星', icon: '⭐' }, { label: '雨伞', icon: '☂️' },
  { label: '钥匙', icon: '🔑' }, { label: '电话', icon: '☎️' },
  { label: '灯泡', icon: '💡' }, { label: '书本', icon: '📘' },
  { label: '铅笔', icon: '✏️' }, { label: '礼物', icon: '🎁' },
  { label: '气球', icon: '🎈' }, { label: '爱心', icon: '❤️' },
  { label: '火焰', icon: '🔥' }, { label: '雪花', icon: '❄️' },
  { label: '小狗', icon: '🐶' }, { label: '小猫', icon: '🐱' },
  { label: '熊', icon: '🐻' }, { label: '熊猫', icon: '🐼' },
  { label: '青蛙', icon: '🐸' }, { label: '狮子', icon: '🦁' },
  { label: '猴子', icon: '🐵' }, { label: '小鸡', icon: '🐥' },
  { label: '企鹅', icon: '🐧' }, { label: '鲸鱼', icon: '🐳' },
  { label: '章鱼', icon: '🐙' }, { label: '蝴蝶', icon: '🦋' }
]

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

  if (await nfd.get('trusted-' + uid, { type: 'json' })) {
    return handleGuestMessage(message)
  }
  if (await isVerified(uid)) return handleGuestMessage(message)

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

async function isVerified (uid) {
  const state = await nfd.get('verified-' + uid, { type: 'json' })
  return state?.version === VERIFIED_VERSION &&
    Number.isFinite(state.expiresAt) && state.expiresAt > Date.now()
}

async function saveVerificationSession (uid) {
  const verifiedAt = Date.now()
  const state = {
    version: VERIFIED_VERSION,
    verifiedAt,
    expiresAt: verifiedAt + VERIFIED_TTL_SECONDS * 1000
  }
  // Do not forward until the verification grant has been saved. The timestamp
  // is fixed here; subsequent visitor messages never extend this session.
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) await wait(1100)
    try {
      await nfd.put('verified-' + uid, JSON.stringify(state), {
        expirationTtl: VERIFIED_TTL_SECONDS
      })
      return true
    } catch (error) {
      if (attempt === 3) console.error(`verification grant write failed for UID ${uid}: ${error}`)
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
      text: '使用方法，回复转发的消息，并发送回复消息，或者`/block`、`/unblock`、`/checkblock`等指令'
    })
  }
  if (/^\/block$/.exec(message.text)) return handleBlock(message)
  if (/^\/unblock$/.exec(message.text)) return handleUnBlock(message)
  if (/^\/checkblock$/.exec(message.text)) return checkBlock(message)

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

function shuffle (values) {
  const result = [...values]
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[result[i], result[j]] = [result[j], result[i]]
  }
  return result
}

function captchaText (challenge) {
  return `为防止自动广告，请连续完成两次简单验证。\n\n第 ${challenge.round}/${CAPTCHA_ROUNDS} 次：请选择「${challenge.targetLabel}」`
}

function createCaptcha (userId, chatId, failures = 0, messageId = null, expiresAt = null, round = 1) {
  const now = Date.now()
  const target = CAPTCHA_ICONS[Math.floor(Math.random() * CAPTCHA_ICONS.length)]
  const distractors = shuffle(CAPTCHA_ICONS.filter(item => item.icon !== target.icon)).slice(0, 5)
  const options = shuffle([target, ...distractors]).map((item, index) => ({
    id: index.toString(),
    icon: item.icon
  }))
  const correctOptionId = options.find(option => option.icon === target.icon).id
  return {
    id: crypto.randomUUID(),
    userId,
    version: CAPTCHA_VERSION,
    round,
    targetLabel: target.label,
    options,
    correctOptionId,
    failures,
    status: 'active',
    createdAt: now,
    expiresAt: expiresAt || now + CAPTCHA_TTL_SECONDS * 1000,
    writtenAt: null,
    chatId,
    messageId
  }
}

function captchaKeyboard (challenge) {
  const buttons = challenge.options.map(option => ({
    text: option.icon,
    callback_data: `captcha:${challenge.id}:${option.id}`
  }))
  return { inline_keyboard: [buttons.slice(0, 3), buttons.slice(3, 6)] }
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
  if (remainingTtl(challenge.expiresAt) <= 0) return false
  const response = await sendMessage({
    chat_id: challenge.chatId,
    text: captchaText(challenge),
    reply_markup: captchaKeyboard(challenge)
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
  const previous = captchaCreationQueues.get(uid) || Promise.resolve()
  const current = previous.then(async () => {
    const key = 'captcha-' + uid
    const existing = await nfd.get(key, { type: 'json' })
    const now = Date.now()
    if (existing?.version === CAPTCHA_VERSION && existing.status === 'active' && existing.messageId && existing.expiresAt > now) {
      const claim = await nfd.get('captcha-claim-' + existing.id, { type: 'json' })
      if (!claim || now - claim.claimedAt <= CAPTCHA_PROCESSING_TIMEOUT_MS) return
      await waitForCaptchaWrite(existing)
    } else if (existing?.status === 'completed') {
      await waitForCaptchaWrite(existing)
    }

    const continuesActiveSession = existing?.status === 'active' && existing.expiresAt > now
    const expiresAt = continuesActiveSession
      ? existing.expiresAt
      : pending?.expiresAt > now ? pending.expiresAt : now + CAPTCHA_TTL_SECONDS * 1000
    const failures = continuesActiveSession ? existing.failures || 0 : 0
    const challenge = createCaptcha(uid, message.chat.id, failures, null, expiresAt, 1)
    await sendAndStoreCaptcha(key, challenge)
  })
  captchaCreationQueues.set(uid, current)
  try {
    await current
  } finally {
    if (captchaCreationQueues.get(uid) === current) captchaCreationQueues.delete(uid)
  }
}

async function onCallbackQuery (query) {
  try {
    if (query.message?.chat?.type !== 'private') return

    const uid = query.from.id.toString()
    if (uid === ADMIN_UID) return
    if (await nfd.get('isblocked-' + uid, { type: 'json' })) return
    if (await isTemporarilyRestricted(uid)) return

    const stateKey = 'captcha-' + uid
    const state = await nfd.get(stateKey, { type: 'json' })
    if (!state || state.version !== CAPTCHA_VERSION || state.status !== 'active' || !state.messageId || state.expiresAt <= Date.now()) return
    if (state.userId?.toString() !== uid) return
    if (state.chatId.toString() !== query.message.chat.id.toString() || state.messageId !== query.message.message_id) return

    const parts = (query.data || '').split(':')
    if (parts.length !== 3 || parts[0] !== 'captcha' || parts[1] !== state.id) return
    const selectedOption = state.options.find(option => option.id === parts[2])
    if (!selectedOption) return

    let deleted
    try {
      deleted = await deleteMessage({
        chat_id: state.chatId,
        message_id: state.messageId
      })
    } catch (error) {
      console.error(`captcha claim delete failed: ${error}`)
      return
    }
    if (deleted?.ok !== true) return

    const claimedAt = Date.now()
    await writeCaptchaClaim(state, uid, claimedAt)

    if (selectedOption.id !== state.correctOptionId) {
      const failures = state.failures + 1
      if (failures >= CAPTCHA_MAX_FAILURES) {
        await nfd.put('captcha-block-' + uid, 'true', { expirationTtl: CAPTCHA_BLOCK_SECONDS })
        await sendMessage({ chat_id: state.chatId, text: '验证失败次数过多，请 1 小时后再试。' })
        return
      }

      const ttl = remainingTtl(state.expiresAt)
      if (ttl <= 0) return
      await waitForCaptchaWrite(state)
      const replacement = createCaptcha(uid, state.chatId, failures, null, state.expiresAt, 1)
      await sendAndStoreCaptcha(stateKey, replacement)
      return
    }

    if (state.round < CAPTCHA_ROUNDS) {
      const ttl = remainingTtl(state.expiresAt)
      if (ttl <= 0) return
      await waitForCaptchaWrite(state)
      const replacement = createCaptcha(uid, state.chatId, state.failures, null, state.expiresAt, state.round + 1)
      await sendAndStoreCaptcha(stateKey, replacement)
      return
    }

    // A visitor may have been blocked while answering the challenge.
    if (await nfd.get('isblocked-' + uid, { type: 'json' })) return
    if (await isTemporarilyRestricted(uid)) return
    if (!await saveVerificationSession(uid)) {
      await markStateCompleted(stateKey, state, `captcha state for UID ${uid}`)
      await sendMessage({
        chat_id: state.chatId,
        text: '验证结果保存失败，原消息尚未发送。请重新发送一条消息以再次验证。'
      })
      return
    }
    if (await nfd.get('isblocked-' + uid, { type: 'json' })) {
      await revokeVisitorAccess(uid)
      return
    }
    if (await isTemporarilyRestricted(uid)) return

    const pendingKey = 'pending-message-' + uid
    const pending = await nfd.get(pendingKey, { type: 'json' })
    let resultText = '✅ 验证成功，24 小时内可直接发送消息。请发送您的问题。'
    if (pending && pending.status !== 'completed' && pending.expiresAt > Date.now() &&
      pending.chatId?.toString() === uid && Number.isInteger(pending.messageId)) {
      const forwardResult = await forwardGuestMessage(pending.chatId, pending.messageId)
      if (forwardResult.forwarded) {
        resultText = '✅ 验证成功，您的消息已发送，24 小时内可继续发送消息。验证期间的其他消息请重新发送。'
      } else {
        resultText = '✅ 验证成功，但原消息发送失败，请重新发送一次。'
      }
      if (forwardResult.forwarded) {
        try {
          await handleNotify({ chat: { id: pending.chatId } })
        } catch (error) {
          console.log(`handleNotify failed: ${error}`)
        }
      }
    }
    await Promise.allSettled([
      markStateCompleted(stateKey, state, `captcha state for UID ${uid}`),
      markStateCompleted(pendingKey, pending, `pending message for UID ${uid}`)
    ])
    await sendMessage({ chat_id: state.chatId, text: resultText })
  } finally {
    // Telegram requires every callback to be acknowledged, including ignored stale callbacks.
    await answerCallbackQuery(query.id)
  }
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

async function handleGuestMessage (message) {
  const result = await forwardGuestMessage(message.chat.id, message.message_id)
  if (result.forwarded) return handleNotify(message)
}

async function forwardGuestMessage (chatId, messageId) {
  let forwardReq
  try {
    forwardReq = await forwardMessage({
      chat_id: ADMIN_UID,
      from_chat_id: chatId,
      message_id: messageId
    })
  } catch (error) {
    console.error(`forwardMessage failed for UID ${chatId}: ${error}`)
    return { forwarded: false, mapped: false, adminMessageId: null }
  }
  console.log(JSON.stringify(forwardReq))
  const adminMessageId = forwardReq?.result?.message_id
  if (forwardReq?.ok !== true || !Number.isInteger(adminMessageId)) {
    return { forwarded: false, mapped: false, adminMessageId: null }
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) await wait(1100)
    try {
      await nfd.put('msg-map-' + adminMessageId, chatId.toString())
      return { forwarded: true, mapped: true, adminMessageId }
    } catch (error) {
      if (attempt === 3) {
        console.error(`msg-map write failed after 3 attempts for UID ${chatId}, admin message ${adminMessageId}: ${error}`)
      }
    }
  }
  return { forwarded: true, mapped: false, adminMessageId }
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
  console.log(JSON.stringify(arr))
  const flag = arr.filter(v => v === id).length !== 0
  console.log(flag)
  return flag
}

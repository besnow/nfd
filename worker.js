const TOKEN = ENV_BOT_TOKEN // Get it from @BotFather
const WEBHOOK = '/endpoint'
const SECRET = ENV_BOT_SECRET // A-Z, a-z, 0-9, _ and -
const ADMIN_UID = ENV_ADMIN_UID.toString() // your user id, get it from https://t.me/username_to_id_bot

const NOTIFY_INTERVAL = 3600 * 1000
const CAPTCHA_TTL_SECONDS = 10 * 60
const CAPTCHA_PROCESSING_TIMEOUT_MS = 30 * 1000
const CAPTCHA_BLOCK_SECONDS = 60 * 60
const RATE_BLOCK_SECONDS = 24 * 60 * 60
const fraudDb = 'https://raw.githubusercontent.com/LloydAsp/nfd/main/data/fraud.db'
const notificationUrl = 'https://raw.githubusercontent.com/LloydAsp/nfd/main/data/notification.txt'
const startMsgUrl = 'https://raw.githubusercontent.com/LloydAsp/nfd/main/data/startMessage.md'

const enable_notification = true
const pendingSaveQueues = new Map()
const captchaCreationQueues = new Map()

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

  const verified = await nfd.get('verified-' + uid, { type: 'json' })
  if (!verified) {
    const pending = message.text !== '/start' ? await savePendingMessage(message) : null
    await ensureCaptcha(message, pending)
    return
  }

  if (message.text === '/start') {
    const startMsg = await fetch(startMsgUrl).then(r => r.text())
    return sendMessage({ chat_id: message.chat.id, text: startMsg })
  }
  return handleGuestMessage(message)
}

async function handleAdminMessage (message) {
  if (message.text === '/start') {
    const startMsg = await fetch(startMsgUrl).then(r => r.text())
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
  return copyMessage({
    chat_id: guestChatId,
    from_chat_id: message.chat.id,
    message_id: message.message_id
  })
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
  return `为防止广告消息，请完成一个简单验证：\n${challenge.left} ${challenge.operator} ${challenge.right} = ?`
}

function createCaptcha (userId, chatId, failures = 0, messageId = null, expiresAt = null) {
  const now = Date.now()
  const operator = Math.random() < 0.5 ? '+' : '-'
  let left = Math.floor(Math.random() * 21)
  let right = operator === '+'
    ? Math.floor(Math.random() * (21 - left))
    : Math.floor(Math.random() * 21)
  if (operator === '-' && right > left) {
    ;[left, right] = [right, left]
  }
  const answer = operator === '+' ? left + right : left - right
  const candidates = []
  for (let distance = 1; candidates.length < 2; distance++) {
    const nearby = shuffle([answer - distance, answer + distance])
    for (const value of nearby) {
      if (value >= 0 && value !== answer && !candidates.includes(value)) candidates.push(value)
      if (candidates.length === 2) break
    }
  }
  const options = shuffle([answer, ...candidates]).map((value, index) => ({ id: index.toString(), value }))
  const correctOptionId = options.find(option => option.value === answer).id
  return {
    id: crypto.randomUUID(),
    userId,
    left,
    right,
    operator,
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
    text: option.value.toString(),
    callback_data: `captcha:${challenge.id}:${option.id}`
  }))
  return { inline_keyboard: [buttons] }
}

function remainingTtl (expiresAt) {
  const seconds = Math.ceil((expiresAt - Date.now()) / 1000)
  // Workers KV requires expirationTtl to be at least 60 seconds. expiresAt remains
  // the authoritative deadline when less than a minute is left.
  return seconds > 0 ? Math.max(60, seconds) : 0
}

async function savePendingMessage (message, expiresAt = null) {
  const uid = message.from.id.toString()
  const previous = pendingSaveQueues.get(uid) || Promise.resolve()
  const current = previous.then(async () => {
    const key = 'pending-message-' + uid
    const existing = await nfd.get(key, { type: 'json' })
    if (existing) return existing
    const pending = {
      chatId: message.chat.id,
      messageId: message.message_id,
      expiresAt: expiresAt || Date.now() + CAPTCHA_TTL_SECONDS * 1000
    }
    const ttl = remainingTtl(pending.expiresAt)
    if (ttl > 0) await nfd.put(key, JSON.stringify(pending), { expirationTtl: ttl })
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

async function waitForCaptchaWrite (state) {
  const elapsed = Date.now() - (state?.writtenAt || state?.createdAt || 0)
  if (elapsed < 1100) await wait(1100 - elapsed)
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
  challenge.writtenAt = Date.now()
  try {
    await nfd.put(key, JSON.stringify(challenge), { expirationTtl: ttl })
  } catch (error) {
    console.error(`captcha state write failed for UID ${challenge.userId}, message ${challenge.messageId}: ${error}`)
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
    if (existing?.status === 'active' && existing.messageId && existing.expiresAt > now) {
      const claim = await nfd.get('captcha-claim-' + existing.id, { type: 'json' })
      if (!claim || now - claim.claimedAt <= CAPTCHA_PROCESSING_TIMEOUT_MS) return
      if (await nfd.get('verified-' + uid, { type: 'json' })) return
      await waitForCaptchaWrite(existing)
    }

    const expiresAt = existing?.expiresAt > now
      ? existing.expiresAt
      : pending?.expiresAt > now ? pending.expiresAt : now + CAPTCHA_TTL_SECONDS * 1000
    const failures = existing?.expiresAt > now ? existing.failures || 0 : 0
    const challenge = createCaptcha(uid, message.chat.id, failures, null, expiresAt)
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
    if (!state || state.status !== 'active' || !state.messageId || state.expiresAt <= Date.now()) return
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
      if (failures >= 3) {
        await nfd.put('captcha-block-' + uid, 'true', { expirationTtl: CAPTCHA_BLOCK_SECONDS })
        return
      }

      const ttl = remainingTtl(state.expiresAt)
      if (ttl <= 0) return
      await waitForCaptchaWrite(state)
      const replacement = createCaptcha(uid, state.chatId, failures, null, state.expiresAt)
      await sendAndStoreCaptcha(stateKey, replacement)
      return
    }

    await nfd.put('verified-' + uid, 'true')

    const pendingKey = 'pending-message-' + uid
    const pending = await nfd.get(pendingKey, { type: 'json' })
    let resultText = '✅ 验证成功，请发送您的问题。'
    if (pending) {
      const forwardResult = await forwardGuestMessage(pending.chatId, pending.messageId)
      if (forwardResult.forwarded) {
        resultText = '✅ 验证成功，您的消息已发送，请耐心等待回复。'
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
  await Promise.all([
    nfd.put(minuteKey, JSON.stringify(nextMinuteCount), { expirationTtl: 120 }),
    nfd.put(hourKey, JSON.stringify(nextHourCount), { expirationTtl: 7200 })
  ])
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
  if (enable_notification) {
    const lastMsgTime = await nfd.get('lastmsg-' + chatId, { type: 'json' })
    if (!lastMsgTime || Date.now() - lastMsgTime > NOTIFY_INTERVAL) {
      await nfd.put('lastmsg-' + chatId, Date.now())
      return sendMessage({ chat_id: ADMIN_UID, text: await fetch(notificationUrl).then(r => r.text()) })
    }
  }
}

async function handleBlock (message) {
  const guestChatId = await nfd.get('msg-map-' + message.reply_to_message.message_id, { type: 'json' })
  if (guestChatId?.toString() === ADMIN_UID) return sendMessage({ chat_id: ADMIN_UID, text: '不能屏蔽自己' })
  await nfd.put('isblocked-' + guestChatId, true)
  return sendMessage({ chat_id: ADMIN_UID, text: `UID:${guestChatId}屏蔽成功` })
}

async function handleUnBlock (message) {
  const guestChatId = await nfd.get('msg-map-' + message.reply_to_message.message_id, { type: 'json' })
  await nfd.put('isblocked-' + guestChatId, false)
  return sendMessage({ chat_id: ADMIN_UID, text: `UID:${guestChatId}解除屏蔽成功` })
}

async function checkBlock (message) {
  const guestChatId = await nfd.get('msg-map-' + message.reply_to_message.message_id, { type: 'json' })
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

const TOKEN = ENV_BOT_TOKEN // Get it from @BotFather
const WEBHOOK = '/endpoint'
const SECRET = ENV_BOT_SECRET // A-Z, a-z, 0-9, _ and -
const ADMIN_UID = ENV_ADMIN_UID.toString() // your user id, get it from https://t.me/username_to_id_bot

const NOTIFY_INTERVAL = 3600 * 1000
const CAPTCHA_TTL_SECONDS = 10 * 60
const CAPTCHA_BLOCK_SECONDS = 60 * 60
const RATE_BLOCK_SECONDS = 24 * 60 * 60
const fraudDb = 'https://raw.githubusercontent.com/LloydAsp/nfd/main/data/fraud.db'
const notificationUrl = 'https://raw.githubusercontent.com/LloydAsp/nfd/main/data/notification.txt'
const startMsgUrl = 'https://raw.githubusercontent.com/LloydAsp/nfd/main/data/startMessage.md'

const enable_notification = true

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

function editMessageText (msg) {
  return requestTelegram('editMessageText', makeReqBody(msg))
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
    if (message.text !== '/start') await savePendingMessage(message)
    await ensureCaptcha(message)
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

function createCaptcha (userId, chatId, failures = 0, messageId = null, status = 'pending') {
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
    status,
    createdAt: now,
    expiresAt: now + CAPTCHA_TTL_SECONDS * 1000,
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

async function savePendingMessage (message) {
  const key = 'pending-message-' + message.from.id
  if (await nfd.get(key, { type: 'json' })) return
  await nfd.put(key, JSON.stringify({
    chatId: message.chat.id,
    messageId: message.message_id
  }), { expirationTtl: CAPTCHA_TTL_SECONDS })
}

async function ensureCaptcha (message) {
  const uid = message.from.id.toString()
  const key = 'captcha-' + uid
  const existing = await nfd.get(key, { type: 'json' })
  const now = Date.now()
  if (existing?.status === 'active' && existing.messageId && existing.expiresAt > now) return
  if (existing?.status === 'pending' && existing.expiresAt > now && now - existing.createdAt < 10000) return
  const failures = existing?.expiresAt > Date.now() ? existing.failures || 0 : 0

  const challenge = createCaptcha(uid, message.chat.id, failures)
  await nfd.put(key, JSON.stringify(challenge), { expirationTtl: CAPTCHA_TTL_SECONDS })
  try {
    const response = await sendMessage({
      chat_id: message.chat.id,
      text: captchaText(challenge),
      reply_markup: captchaKeyboard(challenge)
    })
    if (!response.ok || !response.result?.message_id) {
      await deleteCaptchaIfCurrent(key, challenge.id)
      return
    }
    const current = await nfd.get(key, { type: 'json' })
    if (current?.id !== challenge.id) {
      await deleteMessage({ chat_id: message.chat.id, message_id: response.result.message_id })
      return
    }
    challenge.status = 'active'
    challenge.messageId = response.result.message_id
    await nfd.put(key, JSON.stringify(challenge), { expirationTtl: CAPTCHA_TTL_SECONDS })
  } catch (error) {
    await deleteCaptchaIfCurrent(key, challenge.id)
    throw error
  }
}

async function deleteCaptchaIfCurrent (key, challengeId) {
  const current = await nfd.get(key, { type: 'json' })
  if (current?.id === challengeId) await nfd.delete(key)
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

    if (selectedOption.id !== state.correctOptionId) {
      const failures = state.failures + 1
      if (failures >= 3) {
        await nfd.put('captcha-block-' + uid, 'true', { expirationTtl: CAPTCHA_BLOCK_SECONDS })
        await deleteCaptchaIfCurrent(stateKey, state.id)
        return
      }

      // Saving a new challenge first makes every button from the previous challenge stale.
      const replacement = createCaptcha(uid, state.chatId, failures, state.messageId, 'active')
      await nfd.put(stateKey, JSON.stringify(replacement), { expirationTtl: CAPTCHA_TTL_SECONDS })
      try {
        const response = await editMessageText({
          chat_id: state.chatId,
          message_id: state.messageId,
          text: captchaText(replacement),
          reply_markup: captchaKeyboard(replacement)
        })
        if (!response.ok) {
          await deleteCaptchaIfCurrent(stateKey, replacement.id)
        }
      } catch (error) {
        await deleteCaptchaIfCurrent(stateKey, replacement.id)
        throw error
      }
      return
    }

    // Invalidate the buttons before forwarding so repeated callbacks cannot resend the message.
    state.status = 'processing'
    await nfd.put(stateKey, JSON.stringify(state), { expirationTtl: CAPTCHA_TTL_SECONDS })
    await nfd.put('verified-' + uid, 'true')

    const pendingKey = 'pending-message-' + uid
    const pending = await nfd.get(pendingKey, { type: 'json' })
    let resultText = '✅ 验证成功，请发送您的问题。'
    if (pending) {
      const forwarded = await forwardGuestMessage(pending.chatId, pending.messageId)
      if (forwarded) {
        resultText = '✅ 验证成功，您的消息已发送，请耐心等待回复。'
      } else {
        resultText = '✅ 验证成功，但原消息发送失败，请重新发送一次。'
      }
      await nfd.delete(pendingKey)
      await deleteCaptchaIfCurrent(stateKey, state.id)
      if (forwarded) {
        try {
          await handleNotify({ chat: { id: pending.chatId } })
        } catch (error) {
          console.log(`handleNotify failed: ${error}`)
        }
      }
    } else {
      await deleteCaptchaIfCurrent(stateKey, state.id)
    }
    await editMessageText({
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
      text: resultText,
      reply_markup: { inline_keyboard: [] }
    })
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
  const forwarded = await forwardGuestMessage(message.chat.id, message.message_id)
  if (forwarded) return handleNotify(message)
}

async function forwardGuestMessage (chatId, messageId) {
  try {
    const forwardReq = await forwardMessage({
      chat_id: ADMIN_UID,
      from_chat_id: chatId,
      message_id: messageId
    })
    console.log(JSON.stringify(forwardReq))
    if (forwardReq.ok) await nfd.put('msg-map-' + forwardReq.result.message_id, chatId)
    return Boolean(forwardReq.ok)
  } catch (error) {
    console.log(`forwardMessage failed: ${error}`)
    return false
  }
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

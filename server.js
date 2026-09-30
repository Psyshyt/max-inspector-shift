require('dotenv').config();

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '2mb' }));

const API_BASE = 'https://platform-api2.max.ru';
const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const REPORT_CHAT_ID = process.env.REPORT_CHAT_ID || '';
const PORT = Number(process.env.PORT || 3000);
const STORE_PATH = process.env.STORE_PATH || path.join(__dirname, 'data', 'store.json');

if (!BOT_TOKEN) {
  console.error('BOT_TOKEN is required');
  process.exit(1);
}

const directory = path.dirname(STORE_PATH);
fs.mkdirSync(directory, { recursive: true });

function defaultStore() {
  return {
    version: 1,
    users: {},
    shifts: {},
    processedCallbacks: {},
    processedMessages: {}
  };
}

function loadStore() {
  try {
    if (!fs.existsSync(STORE_PATH)) return defaultStore();
    const data = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    return { ...defaultStore(), ...data };
  } catch (error) {
    console.error('Failed to load store:', error);
    return defaultStore();
  }
}

let store = loadStore();

function saveStore() {
  const tmp = `${STORE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, STORE_PATH);
}

function nowIso() {
  return new Date().toISOString();
}

function randomId(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

function formatDateTime(value) {
  const d = new Date(value);
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: process.env.TZ || 'Europe/Moscow',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  }).format(d);
}

function formatTime(value) {
  const d = new Date(value);
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: process.env.TZ || 'Europe/Moscow',
    hour: '2-digit', minute: '2-digit'
  }).format(d);
}

function durationText(start, end) {
  const totalMinutes = Math.max(0, Math.round((new Date(end) - new Date(start)) / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours} ч. ${minutes.toString().padStart(2, '0')} мин.`;
}

function displayName(user = {}) {
  const parts = [user.first_name, user.last_name].filter(Boolean);
  return parts.join(' ').trim() || user.name || user.username || `ID ${user.user_id || 'unknown'}`;
}

async function maxApi(pathname, options = {}) {
  const response = await fetch(`${API_BASE}${pathname}`, {
    ...options,
    headers: {
      Authorization: BOT_TOKEN,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });

  const raw = await response.text();
  let body;
  try { body = raw ? JSON.parse(raw) : {}; } catch { body = { raw }; }

  if (!response.ok) {
    throw new Error(`MAX API ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

function callbackButton(text, payload, intent = 'default') {
  return { type: 'callback', text, payload, intent };
}

function keyboard(rows) {
  return [{ type: 'inline_keyboard', payload: { buttons: rows } }];
}

async function sendToUser(userId, text, rows = null) {
  const payload = { text };
  if (rows) payload.attachments = keyboard(rows);
  return maxApi(`/messages?user_id=${encodeURIComponent(userId)}`, {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

async function sendToChat(chatId, text) {
  if (!chatId) return null;
  return maxApi(`/messages?chat_id=${encodeURIComponent(chatId)}`, {
    method: 'POST',
    body: JSON.stringify({ text })
  });
}

async function answerCallback(callbackId, message = null) {
  const body = message ? { message } : {};
  return maxApi(`/answers?callback_id=${encodeURIComponent(callbackId)}`, {
    method: 'POST',
    body: JSON.stringify(body)
  });
}

const MENU = {
  start: [[callbackButton('🟢 Начать смену', 'shift:start', 'positive')]],
  active: [
    [callbackButton('📹 Зафиксировать нарушение', 'violation:new', 'positive')],
    [callbackButton('📊 Моя смена', 'shift:status')],
    [callbackButton('🔴 Завершить смену', 'shift:finish_request', 'negative')]
  ],
  violationType: [
    [callbackButton('🔒 Закрыт ГРЗ', 'violation:type:covered')],
    [callbackButton('🚫 Без ГРЗ', 'violation:type:none')],
    [callbackButton('❌ Отменить', 'violation:cancel', 'negative')]
  ],
  finishConfirm: [
    [callbackButton('✅ Завершить', 'shift:finish_confirm', 'positive')],
    [callbackButton('↩️ Продолжить работу', 'shift:finish_cancel')]
  ]
};

function ensureUser(user) {
  const id = String(user.user_id);
  if (!store.users[id]) {
    store.users[id] = {
      userId: id,
      name: displayName(user),
      username: user.username || null,
      firstSeenAt: nowIso(),
      currentShiftId: null,
      state: 'idle',
      pendingVideo: null
    };
  } else {
    store.users[id].name = displayName(user);
    store.users[id].username = user.username || store.users[id].username || null;
  }
  saveStore();
  return store.users[id];
}

function getActiveShift(userRecord) {
  if (!userRecord.currentShiftId) return null;
  const shift = store.shifts[userRecord.currentShiftId];
  return shift && shift.status === 'active' ? shift : null;
}

function counts(shift) {
  const covered = shift.violations.filter(v => v.type === 'covered').length;
  const none = shift.violations.filter(v => v.type === 'none').length;
  return { covered, none, total: covered + none };
}

function extractMessage(update) {
  return update.message || update.callback?.message || null;
}

function extractUser(update) {
  return update.user || update.callback?.user || update.message?.sender || update.callback?.message?.sender || null;
}

function extractUserId(update) {
  const user = extractUser(update);
  return user?.user_id != null ? String(user.user_id) : null;
}

function extractText(message) {
  return (message?.body?.text || '').trim();
}

function extractAttachments(message) {
  return Array.isArray(message?.body?.attachments) ? message.body.attachments : [];
}

function extractMessageId(message) {
  return message?.body?.mid || message?.body?.message_id || message?.message_id || null;
}

function extractVideoAttachment(message) {
  return extractAttachments(message).find(a => a?.type === 'video') || null;
}

function compactVideoRef(message, attachment) {
  const payload = attachment?.payload || {};
  return {
    sourceMessageId: extractMessageId(message),
    token: payload.token || null,
    url: payload.url || payload.video_url || null,
    attachmentId: payload.id || payload.video_id || null
  };
}

async function showWelcome(userId, hasActiveShift = false) {
  if (hasActiveShift) {
    return sendToUser(userId,
      'У вас уже открыта смена. Продолжайте фиксировать нарушения или завершите её через меню.',
      MENU.active
    );
  }
  return sendToUser(userId,
    '👋 Добро пожаловать в систему контроля работы пеших инспекторов.\n\nВо время смены фиксируйте на видео транспортные средства с закрытым ГРЗ или без ГРЗ. После отправки видео бот попросит выбрать тип нарушения.\n\nДля начала работы нажмите «Начать смену».',
    MENU.start
  );
}

async function startShift(userId, userRecord) {
  const active = getActiveShift(userRecord);
  if (active) {
    await sendToUser(userId, `⚠️ У вас уже открыта смена с ${formatTime(active.startedAt)}.`, MENU.active);
    return;
  }

  const shiftId = randomId('shift');
  const startedAt = nowIso();
  store.shifts[shiftId] = {
    id: shiftId,
    inspectorUserId: userId,
    inspectorName: userRecord.name,
    startedAt,
    endedAt: null,
    status: 'active',
    violations: []
  };
  userRecord.currentShiftId = shiftId;
  userRecord.state = 'active';
  userRecord.pendingVideo = null;
  saveStore();

  await sendToUser(userId,
    `🟢 Смена начата\nВремя: ${formatDateTime(startedAt)}\n\nТеперь можно фиксировать нарушения.`,
    MENU.active
  );

  if (REPORT_CHAT_ID) {
    await sendToChat(REPORT_CHAT_ID,
      `🟢 Смена начата\n👤 Инспектор: ${userRecord.name}\n🕐 Начало: ${formatDateTime(startedAt)}`
    );
  }
}

async function requestViolation(userId, userRecord) {
  const shift = getActiveShift(userRecord);
  if (!shift) {
    await sendToUser(userId, 'Сначала необходимо начать смену.', MENU.start);
    return;
  }
  userRecord.state = 'waiting_video';
  userRecord.pendingVideo = null;
  saveStore();
  await sendToUser(userId, '📹 Пришлите видео автомобиля с нарушением.\n\nПосле видео я попрошу выбрать тип нарушения.');
}

async function receiveVideo(userId, userRecord, message, videoAttachment) {
  const shift = getActiveShift(userRecord);
  if (!shift) {
    await sendToUser(userId, '⚠️ Видео не принято: у вас нет открытой смены.', MENU.start);
    return;
  }

  if (userRecord.state !== 'waiting_video') {
    await sendToUser(userId,
      'Чтобы добавить видео в отчёт, сначала нажмите «📹 Зафиксировать нарушение».',
      MENU.active
    );
    return;
  }

  const messageId = extractMessageId(message);
  if (messageId && store.processedMessages[String(messageId)]) return;
  if (messageId) store.processedMessages[String(messageId)] = nowIso();

  userRecord.pendingVideo = {
    id: randomId('video'),
    receivedAt: nowIso(),
    ...compactVideoRef(message, videoAttachment)
  };
  userRecord.state = 'waiting_violation_type';
  saveStore();

  await sendToUser(userId,
    'Видео получено ✅\n\nКакое нарушение зафиксировано?',
    MENU.violationType
  );
}

async function saveViolation(userId, userRecord, type) {
  const shift = getActiveShift(userRecord);
  if (!shift) {
    userRecord.state = 'idle';
    userRecord.pendingVideo = null;
    saveStore();
    await sendToUser(userId, 'Смена уже закрыта. Видео не было добавлено.', MENU.start);
    return;
  }
  if (userRecord.state !== 'waiting_violation_type' || !userRecord.pendingVideo) {
    await sendToUser(userId, 'Нет видео, ожидающего классификации.', MENU.active);
    return;
  }

  const violation = {
    id: randomId('violation'),
    type,
    typeLabel: type === 'covered' ? 'Закрыт ГРЗ' : 'Без ГРЗ',
    createdAt: nowIso(),
    video: userRecord.pendingVideo
  };
  shift.violations.push(violation);
  userRecord.pendingVideo = null;
  userRecord.state = 'active';
  saveStore();

  const c = counts(shift);
  await sendToUser(userId,
    `✅ Нарушение зафиксировано\nТип: ${violation.typeLabel}\nВремя: ${formatTime(violation.createdAt)}\n\nЗа смену: ${c.total}\n🔒 Закрыт ГРЗ: ${c.covered}\n🚫 Без ГРЗ: ${c.none}`,
    MENU.active
  );
}

async function cancelViolation(userId, userRecord) {
  userRecord.pendingVideo = null;
  userRecord.state = getActiveShift(userRecord) ? 'active' : 'idle';
  saveStore();
  await sendToUser(userId, '❌ Фиксация отменена.', getActiveShift(userRecord) ? MENU.active : MENU.start);
}

async function showShiftStatus(userId, userRecord) {
  const shift = getActiveShift(userRecord);
  if (!shift) {
    await sendToUser(userId, 'Сейчас у вас нет открытой смены.', MENU.start);
    return;
  }
  const c = counts(shift);
  await sendToUser(userId,
    `📊 Текущая смена\n\n🕐 Начало: ${formatDateTime(shift.startedAt)}\n🚗 Всего нарушений: ${c.total}\n🔒 Закрыт ГРЗ: ${c.covered}\n🚫 Без ГРЗ: ${c.none}`,
    MENU.active
  );
}

async function finishRequest(userId, userRecord) {
  const shift = getActiveShift(userRecord);
  if (!shift) {
    await sendToUser(userId, 'Открытой смены нет.', MENU.start);
    return;
  }
  const c = counts(shift);
  await sendToUser(userId,
    `Завершить текущую смену?\n\nЗафиксировано автомобилей: ${c.total}\n🔒 Закрыт ГРЗ: ${c.covered}\n🚫 Без ГРЗ: ${c.none}`,
    MENU.finishConfirm
  );
}

async function finishShift(userId, userRecord) {
  const shift = getActiveShift(userRecord);
  if (!shift) {
    await sendToUser(userId, 'Открытой смены нет.', MENU.start);
    return;
  }

  const endedAt = nowIso();
  shift.endedAt = endedAt;
  shift.status = 'closed';
  userRecord.currentShiftId = null;
  userRecord.state = 'idle';
  userRecord.pendingVideo = null;
  saveStore();

  const c = counts(shift);
  const report =
    `🔴 Смена завершена\n\n` +
    `👤 Инспектор: ${shift.inspectorName}\n` +
    `🕐 Начало: ${formatDateTime(shift.startedAt)}\n` +
    `🕐 Окончание: ${formatDateTime(endedAt)}\n` +
    `⏱ Продолжительность: ${durationText(shift.startedAt, endedAt)}\n\n` +
    `🚗 Всего выявлено: ${c.total}\n` +
    `🔒 Закрытый ГРЗ: ${c.covered}\n` +
    `🚫 Без ГРЗ: ${c.none}`;

  await sendToUser(userId, `${report}\n\nНовая смена может быть начата в любое время.`, MENU.start);
  if (REPORT_CHAT_ID) await sendToChat(REPORT_CHAT_ID, report);
}

async function handleMessageCreated(update) {
  const message = extractMessage(update);
  const user = extractUser(update);
  const userId = extractUserId(update);
  if (!message || !user || !userId) return;

  const userRecord = ensureUser(user);
  const text = extractText(message);
  const video = extractVideoAttachment(message);

  if (text === '/start' || text.startsWith('/start ')) {
    await showWelcome(userId, Boolean(getActiveShift(userRecord)));
    return;
  }

  if (video) {
    await receiveVideo(userId, userRecord, message, video);
    return;
  }

  if (text) {
    await sendToUser(userId,
      getActiveShift(userRecord)
        ? 'Используйте кнопки меню для работы со сменой.'
        : 'Для начала работы нажмите кнопку ниже.',
      getActiveShift(userRecord) ? MENU.active : MENU.start
    );
  }
}

async function handleBotStarted(update) {
  const user = extractUser(update);
  const userId = extractUserId(update);
  if (!user || !userId) return;
  const userRecord = ensureUser(user);
  await showWelcome(userId, Boolean(getActiveShift(userRecord)));
}

async function handleCallback(update) {
  const callback = update.callback || {};
  const callbackId = callback.callback_id;
  const payload = callback.payload;
  const user = extractUser(update);
  const userId = extractUserId(update);
  if (!callbackId || !payload || !user || !userId) return;

  if (store.processedCallbacks[callbackId]) {
    try { await answerCallback(callbackId); } catch (_) {}
    return;
  }
  store.processedCallbacks[callbackId] = nowIso();
  saveStore();

  const userRecord = ensureUser(user);
  try { await answerCallback(callbackId); } catch (error) { console.error('answerCallback:', error.message); }

  switch (payload) {
    case 'shift:start': return startShift(userId, userRecord);
    case 'violation:new': return requestViolation(userId, userRecord);
    case 'violation:type:covered': return saveViolation(userId, userRecord, 'covered');
    case 'violation:type:none': return saveViolation(userId, userRecord, 'none');
    case 'violation:cancel': return cancelViolation(userId, userRecord);
    case 'shift:status': return showShiftStatus(userId, userRecord);
    case 'shift:finish_request': return finishRequest(userId, userRecord);
    case 'shift:finish_confirm': return finishShift(userId, userRecord);
    case 'shift:finish_cancel': return sendToUser(userId, 'Продолжаем смену.', MENU.active);
    default: return sendToUser(userId, 'Неизвестная команда. Показываю актуальное меню.', getActiveShift(userRecord) ? MENU.active : MENU.start);
  }
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'max-inspector-shift', version: '0.1.0', time: nowIso() });
});

app.post('/webhook', (req, res) => {
  if (WEBHOOK_SECRET) {
    const received = req.get('X-Max-Bot-Api-Secret') || '';
    if (received !== WEBHOOK_SECRET) {
      return res.status(401).json({ ok: false });
    }
  }

  // MAX requires 200 quickly. Process after acknowledging receipt.
  res.status(200).json({ ok: true });

  const update = req.body;
  Promise.resolve().then(async () => {
    try {
      switch (update.update_type) {
        case 'bot_started': await handleBotStarted(update); break;
        case 'message_created': await handleMessageCreated(update); break;
        case 'message_callback': await handleCallback(update); break;
        case 'bot_added': console.log('Bot added to chat:', update.chat_id); break;
        default: break;
      }
    } catch (error) {
      console.error('Webhook processing error:', error);
    }
  });
});

app.use((_req, res) => res.status(404).json({ ok: false, error: 'Not found' }));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`max-inspector-shift v0.1.0 listening on port ${PORT}`);
  console.log(`Store: ${STORE_PATH}`);
  console.log(`Report chat: ${REPORT_CHAT_ID || 'not configured'}`);
});

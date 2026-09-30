require('dotenv').config();

const API_BASE = 'https://platform-api2.max.ru';
const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

if (!BOT_TOKEN || !WEBHOOK_URL || !WEBHOOK_SECRET) {
  console.error('Missing BOT_TOKEN, WEBHOOK_URL or WEBHOOK_SECRET in .env');
  process.exit(1);
}

async function api(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
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

(async () => {
  try {
    const result = await api('/subscriptions', {
      method: 'POST',
      body: JSON.stringify({
        url: WEBHOOK_URL,
        update_types: ['bot_started', 'message_created', 'message_callback', 'bot_added'],
        secret: WEBHOOK_SECRET
      })
    });
    console.log('Webhook subscription result:');
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
})();

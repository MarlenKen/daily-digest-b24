// index.js
import 'dotenv/config';
import axios from 'axios';
import cron from 'node-cron';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import tz from 'dayjs/plugin/timezone.js';
import 'dayjs/locale/ru.js';
import pLimit from 'p-limit';

dayjs.extend(utc);
dayjs.extend(tz);
dayjs.locale('ru');

const {
  BITRIX_BASE_URL,
  BITRIX_WEBHOOK,
  TZ = 'Asia/Almaty',
  CRON_SCHEDULE = '0 9 * * *',
  TASKS_EXCLUDE_COMPLETED = 'true',
  DAY_SPAN_HOURS = '24',
  ONLY_USER_ID,                 // опционально: тест на одного сотрудника (например 41)
  CALENDAR_CHECK_PERMS = 'true' // 1 = проверять права календаря, 0 = не проверять
} = process.env;

if (!BITRIX_BASE_URL || !BITRIX_WEBHOOK) {
  console.error('❌ Заполни BITRIX_BASE_URL и BITRIX_WEBHOOK в .env');
  process.exit(1);
}

// корректная склейка: .../rest/1/KEY/
const baseURL =
  `${BITRIX_BASE_URL.replace(/\/+$/, '')}` +
  `${BITRIX_WEBHOOK.replace(/\/+$/, '')}/`;

const api = axios.create({ baseURL, timeout: 20000 });

// маскируем ключ в логах и показываем путь
api.interceptors.request.use(cfg => {
  const safeBase = (api.defaults.baseURL || '').replace(/(\/rest\/\d+\/)[^/]+/, '$1***');
  const path = (cfg.url || '').split('?')[0];
  console.log('→', safeBase + path);
  return cfg;
});

// универсальный вызов REST с нормальными ошибками
async function call(method, params = {}) {
  const m = String(method).replace(/^\/+/, '');
  const url = `${m}.json`;
  try {
    const res = await api.get(url, { params });
    if (res.data && res.data.error) {
      throw new Error(`${m}: ${res.data.error_description || res.data.error}`);
    }
    return res.data.result;
  } catch (e) {
    const status = e?.response?.status;
    const data = e?.response?.data;
    const desc = data?.error_description || data?.error || e.message;
    throw new Error(`${m}: ${status || ''} ${desc}`.trim());
  }
}

// --- данные ---

async function getActiveUsers() {
  const users = await call('user.get', { FILTER: { ACTIVE: true } });
  let filtered = users.filter(u => String(u.ACTIVE) === 'true' && !u.IS_BOT && !u.IS_EXTRANET);
  if (ONLY_USER_ID) filtered = filtered.filter(u => Number(u.ID) === Number(ONLY_USER_ID));
  return filtered;
}

async function getTodaysEvents(userId) {
  const now = dayjs().tz(TZ);
  const dayStart = now.startOf('day');
  const spanHours = Number(DAY_SPAN_HOURS) || 24;

  const from = dayStart.format('YYYY-MM-DD[T]HH:mm:ssZZ');
  const to = dayStart.add(spanHours, 'hour').subtract(1, 'second').format('YYYY-MM-DD[T]HH:mm:ssZZ');

  const result = await call('calendar.event.get', {
    type: 'user',
    ownerId: userId,
    from,
    to,
    'params[checkPermissions]': String(CALENDAR_CHECK_PERMS).toLowerCase() === 'true' ? 1 : 0,
  });
  return result || [];
}

// с пагинацией, чтобы не потерять хвост
async function getOpenTasks(userId) {
  const filter = { RESPONSIBLE_ID: userId };
  if (String(TASKS_EXCLUDE_COMPLETED).toLowerCase() === 'true') filter['!=STATUS'] = 5;

  const select = ['ID', 'TITLE', 'STATUS', 'DEADLINE', 'CREATED_DATE', 'RESPONSIBLE_ID'];
  const order = { DEADLINE: 'asc' };

  let start = 0;
  const tasks = [];
  for (let i = 0; i < 10; i++) {
    const result = await call('tasks.task.list', { filter, select, order, start });
    const batch = result?.tasks || [];
    tasks.push(...batch);
    if (!result?.next) break;
    start = result.next;
  }
  return tasks;
}

// --- отправка ---

function sanitizeMessage(s, max = 3500) {
  const cleaned = String(s).replace(/\r/g, '').trim();
  return cleaned.length > max ? cleaned.slice(0, max - 3) + '…' : cleaned;
}

async function sendImMessageToUser(userId, message) {
  const dialogId = `user${userId}`;
  const msg = sanitizeMessage(message);

  try {
    await call('im.message.add', { DIALOG_ID: dialogId, MESSAGE: msg });
  } catch (err) {
    // фолбэк на персональные уведомления
    const isThisMethod = /im\.message\.add/i.test(err.message);
    const is400 = / 400 /i.test(err.message);
    if (isThisMethod && is400) {
      console.warn(`im.message.add → 400, fallback на im.notify.personal.add для user ${userId}`);
      await call('im.notify.personal.add', { USER_ID: userId, MESSAGE: msg });
      return;
    }
    throw err;
  }
}

// --- форматирование ---

function formatTask(t) {
  return `• [#${t.id || t.ID}] ${t.title || t.TITLE}`;
}

function formatEvent(ev) {
  const title = ev.NAME || ev.name || '(без названия)';
  // не показываем тех. location вида "calendar_93"
  let loc = '';
  if (ev.LOCATION && ev.LOCATION !== 'false' && !/^calendar_\d+/.test(ev.LOCATION)) {
    loc = ` • ${ev.LOCATION}`;
  }
  // без времени вообще
  return `• ${title}${loc}`;
}

// --- основной цикл по сотруднику ---

async function sendDailyDigest(user) {
  const userId = user.ID || user.Id;
  const [events, tasks] = await Promise.all([getTodaysEvents(userId), getOpenTasks(userId)]);

  const todayStr = dayjs().tz(TZ).format('DD.MM.YYYY (dddd)');

  const evLines = events.length ? events.map(formatEvent).join('\n') : '• Событий на сегодня нет';
  const taskLines = tasks.length
    ? tasks.slice(0, 15).map(formatTask).join('\n') + (tasks.length > 15 ? `\n… и ещё ${tasks.length - 15}` : '')
    : '• Открытых задач нет';

  const msg = `Доброе утро, ${user.NAME || user.NAME_FORMAT || ''}! 👋
Ваш дайджест на ${todayStr}:

📅 Календарь:
${evLines}

✅ Задачи:
${taskLines}

Для удобства можете включить рабочий день в Битрикс24: кликнуть справа вверху на свой аватар и нажать кнопку "Начать рабочий день". 
Продуктивного дня и больших успехов в нашем общем деле!`;

  await sendImMessageToUser(userId, msg);
}

// --- запуск ---

async function runOnce() {
  console.log(`▶️  Генерация дайджеста: ${dayjs().tz(TZ).format()}`);
  const users = await getActiveUsers();
  if (!users.length) {
    console.warn('Нет активных пользователей.');
    return;
  }

  const limit = pLimit(4);
  const jobs = users.map(u =>
    limit(() =>
      sendDailyDigest(u)
        .then(() => console.log(`✓ Отправлено: ${u.ID} ${u.NAME}`))
        .catch(err => console.error(`✗ Ошибка ${u.ID} ${u.NAME}:`, err.message))
    )
  );

  await Promise.all(jobs);
  console.log('✅ Дайджест готов.');
}

function schedule() {
  cron.schedule(
    CRON_SCHEDULE,
    () => { runOnce().catch(err => console.error('runOnce error:', err)); },
    { timezone: TZ }
  );
  console.log(`⏰ Планировщик активен: "${CRON_SCHEDULE}" (${TZ})`);
}

// entrypoint
if (process.argv.includes('--now')) {
  runOnce().catch(err => console.error(err));
} else {
  schedule();
}

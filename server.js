const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const webpush = require('web-push');
const cron = require('node-cron');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DATA_FILE = path.join(__dirname, 'data.json');
const VAPID_FILE = path.join(__dirname, 'vapid.json');

// VAPID keys — priorité aux variables d'env Railway, sinon fichier local
let VAPID_KEYS;
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  VAPID_KEYS = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
} else if (fs.existsSync(VAPID_FILE)) {
  VAPID_KEYS = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
} else {
  VAPID_KEYS = webpush.generateVAPIDKeys();
  fs.writeFileSync(VAPID_FILE, JSON.stringify(VAPID_KEYS));
}
webpush.setVapidDetails('mailto:hotel-tracker@local.com', VAPID_KEYS.publicKey, VAPID_KEYS.privateKey);

const watchers = new Map();
const pushSubscriptions = new Map();
const hotelCache = new Map();

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' })
    });
  } catch (e) {
    console.error('[TELEGRAM] Erreur envoi:', e.message);
  }
}

function saveData() {
  const data = {
    watchers: [],
    subscriptions: []
  };
  watchers.forEach(w => {
    data.watchers.push({
      id: w.id, url: w.url, roomId: w.roomId, roomName: w.roomName,
      hotelName: w.hotelName, persons: w.persons, sessionId: w.sessionId,
      interval: w.interval, checkin: w.checkin, checkout: w.checkout,
      wasAvailable: w.wasAvailable, lastCheck: w.lastCheck, lastData: w.lastData,
      createdAt: w.createdAt
    });
  });
  pushSubscriptions.forEach((sub, sessionId) => {
    data.subscriptions.push({ sessionId, sub });
  });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function loadData() {
  if (!fs.existsSync(DATA_FILE)) return;
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8').replace(/^﻿/, '');
    const data = JSON.parse(raw);
    (data.subscriptions || []).forEach(({ sessionId, sub }) => {
      pushSubscriptions.set(sessionId, sub);
    });
    (data.watchers || []).forEach(w => {
      watchers.set(w.id, w);
      const job = cron.schedule(`*/${Math.max(1, parseInt(w.interval) || 5)} * * * *`, () => checkAvailability(w.id));
      w.job = job;
      console.log(`[RESTORE] Watcher restauré : ${w.hotelName} — ${w.roomName}`);
    });
  } catch(e) {
    console.error('[LOAD] Erreur chargement data.json:', e.message);
  }
}

function buildBookingUrl(url, checkin, checkout, persons) {
  try {
    const u = new URL(url);
    const today = new Date();
    const tom = new Date(today); tom.setDate(tom.getDate() + 1);
    const cin = checkin || today.toISOString().slice(0,10);
    const cout = checkout || tom.toISOString().slice(0,10);
    const [cy, cm, cd] = cin.split('-');
    const [oy, om, od] = cout.split('-');
    u.searchParams.set('checkin', cin);
    u.searchParams.set('checkout', cout);
    u.searchParams.set('checkin_year', cy);
    u.searchParams.set('checkin_month', cm);
    u.searchParams.set('checkin_monthday', cd);
    u.searchParams.set('checkout_year', oy);
    u.searchParams.set('checkout_month', om);
    u.searchParams.set('checkout_monthday', od);
    u.searchParams.set('group_adults', persons || 2);
    u.searchParams.set('no_rooms', 1);
    return u.toString();
  } catch(e) { return url; }
}

async function scrapeHotel(url, checkin, checkout, persons) {
  const isCloud = !!process.env.RAILWAY_ENVIRONMENT || !!process.env.RENDER || !process.env.LOCALAPPDATA;
  const browser = await puppeteer.launch({
    headless: isCloud ? false : 'new',
    executablePath: isCloud
      ? (process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome-stable')
      : 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--disable-infobars',
      '--window-size=1366,768',
      '--disable-extensions',
      '--disable-gpu',
      '--lang=fr-FR',
    ],
  });

  try {
    const page = await browser.newPage();

    // Désactive les flags qui trahissent un headless browser
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['fr-FR', 'fr', 'en-US', 'en'] });
      window.chrome = { runtime: {} };
    });

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1366, height: 768 });
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
    });

    const isBooking = url.includes('booking.com');
    const isHotels = url.includes('hotels.com') || url.includes('expedia.com');

    const targetUrl = isBooking ? buildBookingUrl(url, checkin, checkout, persons) : url;
    console.log('[SCRAPE] URL:', targetUrl);

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Simule un comportement humain : mouvement de souris + scroll progressif
    await new Promise(r => setTimeout(r, 2000));
    await page.mouse.move(300 + Math.random() * 200, 200 + Math.random() * 100);
    await new Promise(r => setTimeout(r, 500 + Math.random() * 500));
    await page.mouse.move(400 + Math.random() * 200, 400 + Math.random() * 100);
    await new Promise(r => setTimeout(r, 3000));

    let hotelData = { name: '', rooms: [], url };

    if (isBooking) {
      hotelData = await scrapeBooking(page, url);
    } else if (isHotels) {
      hotelData = await scrapeHotelsCom(page, url);
    } else {
      hotelData = await scrapeGeneric(page, url);
    }

    return hotelData;
  } finally {
    await browser.close();
  }
}

async function scrapeBooking(page, url) {
  // Intercepte les réponses réseau contenant les données de chambres
  const capturedRooms = [];
  let hotelNameFromApi = '';

  page.on('response', async response => {
    try {
      const resUrl = response.url();
      const ct = response.headers()['content-type'] || '';
      if (!ct.includes('json')) return;

      // Cherche les endpoints Booking qui retournent les room types
      if (resUrl.includes('rooms') || resUrl.includes('availability') || resUrl.includes('block') || resUrl.includes('property') || resUrl.includes('room_type')) {
        const json = await response.json().catch(() => null);
        if (!json) return;

        const str = JSON.stringify(json);

        // Cherche des objets avec nom de chambre + prix
        const extractRooms = (obj) => {
          if (!obj || typeof obj !== 'object') return;
          // Patterns communs dans les APIs Booking
          if ((obj.room_name || obj.name || obj.title) && (obj.price !== undefined || obj.min_price !== undefined || obj.block_id !== undefined)) {
            const name = obj.room_name || obj.name || obj.title || '';
            if (name && name.length > 2 && name.length < 100) {
              const price = obj.price || obj.min_price || obj.avg_price || '';
              const maxPersons = obj.nr_adults || obj.max_occupancy || obj.max_persons || 2;
              const available = obj.available !== false && obj.is_available !== false && !obj.sold_out;
              capturedRooms.push({ name: String(name).trim(), price: price ? `${price}` : 'Voir le site', maxPersons: parseInt(maxPersons) || 2, available: !!available, id: String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-') });
            }
          }
          if (Array.isArray(obj)) obj.forEach(extractRooms);
          else if (typeof obj === 'object') Object.values(obj).forEach(v => { if (typeof v === 'object') extractRooms(v); });
        };

        extractRooms(json);
        if (!hotelNameFromApi && json.hotel_name) hotelNameFromApi = json.hotel_name;
      }
    } catch(e) {}
  });

  // Scroll pour déclencher les appels API
  for (let i = 1; i <= 4; i++) {
    await page.evaluate(p => { try { window.scrollTo(0, document.body.scrollHeight * p); } catch(e){} }, i * 0.25);
    await new Promise(r => setTimeout(r, 1200));
  }
  await new Promise(r => setTimeout(r, 3000));

  const hotelName = hotelNameFromApi || await page.evaluate(() => {
    for (const s of ['[data-testid="property-name"]', 'h2.pp-header__title', '.hp__hotel-name', 'h1']) {
      const el = document.querySelector(s);
      if (el && el.innerText.trim()) return el.innerText.trim();
    }
    return document.title.split(/[–\-|]/)[0].trim();
  });

  // Déduplique les chambres capturées depuis l'API
  const seen = new Set();
  const rooms = capturedRooms.filter(r => {
    if (seen.has(r.name)) return false;
    seen.add(r.name);
    return true;
  });

  console.log('[BOOKING] Chambres capturées via API:', rooms.length);

  // Si l'API n'a rien donné, fallback HTML
  if (!rooms.length) {
    const htmlRooms = await page.evaluate(() => {
      const clean = s => (s || '').replace(/\s+/g, ' ').trim();
      const seen2 = new Set();
      const result = [];
      document.querySelectorAll('a[data-room-id][id^="room_type_id_"]').forEach(link => {
        try {
          const nameEl = link.querySelector('span');
          const name = clean(nameEl ? nameEl.textContent : link.textContent);
          if (!name || name.length < 2 || seen2.has(name)) return;
          seen2.add(name);
          const roomId = link.getAttribute('data-room-id');
          let price = 'Voir le site', available = false;
          document.querySelectorAll(`select[data-room-id="${roomId}"] option[value="1"]`).forEach(opt => {
            available = true;
            const m = opt.textContent.match(/\d[\d\s,.]*/);
            if (m) price = m[0].trim();
          });
          result.push({ name, price, maxPersons: 2, available, id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-') });
        } catch(e) {}
      });
      return result;
    });
    rooms.push(...htmlRooms);
    console.log('[BOOKING] Fallback HTML:', htmlRooms.length, 'chambres');
  }

  return { name: hotelName, rooms, url };
}

async function scrapeHotelsCom(page, url) {
  const hotelName = await page.evaluate(() => {
    const el = document.querySelector('h1[data-stid], h1.uitk-heading, .hotel-name');
    return el ? el.innerText.trim() : document.title.split('|')[0].trim();
  });

  const rooms = await page.evaluate(() => {
    const roomEls = document.querySelectorAll('[data-stid="content-hotel-rooms"] li, .room-unit-container, .uitk-card');
    const result = [];

    roomEls.forEach(el => {
      const nameEl = el.querySelector('h3, h2, [data-stid="room-name"]');
      const priceEl = el.querySelector('[data-stid="price-summary"], .rate-plan-price');
      const capacityEl = el.querySelector('[aria-label*="guests"], [aria-label*="personnes"]');

      if (nameEl) {
        const name = nameEl.innerText.trim();
        const price = priceEl ? priceEl.innerText.trim() : 'Voir le site';
        const capacity = capacityEl ? (capacityEl.getAttribute('aria-label').match(/\d+/) || ['2'])[0] : '2';
        const avail = !el.querySelector('[class*="sold-out"], [class*="unavailable"]');

        result.push({ name, price, maxPersons: parseInt(capacity) || 2, available: avail, id: name.toLowerCase().replace(/\s+/g, '-') });
      }
    });

    return result;
  });

  return { name: hotelName, rooms, url };
}

async function scrapeGeneric(page, url) {
  const hotelName = await page.evaluate(() => document.title.split(/[|\-–]/)[0].trim());
  return {
    name: hotelName,
    rooms: [{ name: 'Chambre Standard', price: 'Voir le site', maxPersons: 2, available: true, id: 'standard' }],
    url
  };
}

async function checkAvailability(watcherId) {
  const watcher = watchers.get(watcherId);
  if (!watcher) return;

  try {
    const data = await scrapeHotel(watcher.url, watcher.checkin, watcher.checkout, watcher.persons);
    const targetRoom = data.rooms.find(r => r.id === watcher.roomId || r.name === watcher.roomName);

    if (!data.rooms.length) {
      // Scraper a rien trouvé — notif d'erreur (max 1 fois par heure)
      const lastErrKey = `err_${watcherId}`;
      const lastErr = watcher[lastErrKey] || 0;
      if (Date.now() - lastErr > 3600000) {
        watcher[lastErrKey] = Date.now();
        const sub = pushSubscriptions.get(watcher.sessionId);
        if (sub) webpush.sendNotification(sub, JSON.stringify({
          title: '⚠️ Problème de vérification',
          body: `Impossible de lire les chambres de ${watcher.hotelName}. Booking a peut-être changé. Vérifie manuellement.`,
          url: watcher.url
        })).catch(() => {});
        sendTelegram(`⚠️ <b>Problème de vérification</b>\nImpossible de lire les chambres de ${watcher.hotelName}. Vérifie manuellement.\n${watcher.url}`);
      }
    }

    if (targetRoom && targetRoom.available && !watcher.wasAvailable) {
      watcher.wasAvailable = true;
      await sendNotification(watcher, targetRoom);
    } else if (targetRoom && !targetRoom.available) {
      watcher.wasAvailable = false;
    }

    watcher.lastCheck = new Date().toISOString();
    watcher.lastData = targetRoom;
  } catch (e) {
    console.error('Check failed for', watcherId, e.message);
    // Notif si crash total (max 1 fois par heure)
    const lastErrKey = `err_${watcherId}`;
    const lastErr = watcher[lastErrKey] || 0;
    if (Date.now() - lastErr > 3600000) {
      watcher[lastErrKey] = Date.now();
      const sub = pushSubscriptions.get(watcher.sessionId);
      if (sub) webpush.sendNotification(sub, JSON.stringify({
        title: '❌ Erreur de vérification',
        body: `${watcher.hotelName} — ${e.message.slice(0, 80)}`,
        url: watcher.url
      })).catch(() => {});
      sendTelegram(`❌ <b>Erreur de vérification</b>\n${watcher.hotelName} — ${e.message.slice(0, 120)}\n${watcher.url}`);
    }
  }
}

async function sendNotification(watcher, room) {
  const sub = pushSubscriptions.get(watcher.sessionId);
  if (!sub) return;

  const payload = JSON.stringify({
    title: `Chambre disponible ! ${watcher.hotelName}`,
    body: `${room.name} est maintenant disponible — ${room.price}`,
    url: watcher.url,
    icon: '/icon.png'
  });

  try {
    await webpush.sendNotification(sub, payload);
  } catch (e) {
    console.error('Push failed:', e.message);
  }
  sendTelegram(`🎉 <b>Chambre disponible !</b>\n${watcher.hotelName}\n${room.name} — ${room.price}\n${watcher.url}`);
}

// --- Bot Telegram : lien hôtel -> liste de chambres -> choix -> watcher ---
const telegramPending = new Map(); // chatId -> { data, url }
let telegramOffset = 0;

async function telegramReply(chatId, text) {
  if (!TELEGRAM_BOT_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
    });
  } catch (e) {
    console.error('[TELEGRAM] Erreur reply:', e.message);
  }
}

async function handleTelegramMessage(msg) {
  const chatId = String(msg.chat.id);
  if (TELEGRAM_CHAT_ID && chatId !== String(TELEGRAM_CHAT_ID)) return; // ignore les autres
  const text = (msg.text || '').trim();
  if (!text) return;

  if (text === '/start') {
    return telegramReply(chatId, 'Salut ! Envoie-moi un lien Booking.com ou Hotels.com pour démarrer une surveillance.');
  }

  if (/^https?:\/\//i.test(text)) {
    await telegramReply(chatId, '🔍 Analyse de l\'hôtel en cours...');
    try {
      const data = await scrapeHotel(text, null, null, 2);
      if (!data.rooms.length) {
        return telegramReply(chatId, `⚠️ Aucune chambre trouvée pour ${data.name || 'cet hôtel'}. Vérifie le lien manuellement.`);
      }
      telegramPending.set(chatId, { data, url: text });
      const list = data.rooms.map((r, i) => `${i + 1}. ${r.name} — ${r.price} (max ${r.maxPersons} pers.)`).join('\n');
      return telegramReply(chatId, `🏨 <b>${data.name || 'Hôtel'}</b>\n\n${list}\n\nRéponds avec le numéro de la chambre à surveiller.`);
    } catch (e) {
      return telegramReply(chatId, `❌ Erreur : ${e.message}`);
    }
  }

  const num = parseInt(text, 10);
  if (!isNaN(num)) {
    const pending = telegramPending.get(chatId);
    if (!pending) return telegramReply(chatId, 'Envoie d\'abord un lien d\'hôtel.');
    const room = pending.data.rooms[num - 1];
    if (!room) return telegramReply(chatId, 'Numéro invalide, réessaie.');

    createWatcher({
      url: pending.url,
      roomId: room.id,
      roomName: room.name,
      hotelName: pending.data.name,
      persons: 2,
      sessionId: null,
      interval: 5,
      checkin: null,
      checkout: null
    });
    telegramPending.delete(chatId);
    return; // createWatcher envoie déjà la confirmation Telegram
  }
}

async function pollTelegram() {
  if (!TELEGRAM_BOT_TOKEN) return;
  try {
    const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${telegramOffset + 1}&timeout=20`);
    const data = await r.json();
    if (data.ok) {
      for (const update of data.result) {
        telegramOffset = update.update_id;
        if (update.message) await handleTelegramMessage(update.message);
      }
    }
  } catch (e) {
    console.error('[TELEGRAM] Erreur polling:', e.message);
  } finally {
    setTimeout(pollTelegram, 1000);
  }
}
if (TELEGRAM_BOT_TOKEN) pollTelegram();

app.get('/vapid-public-key', (req, res) => {
  res.json({ publicKey: VAPID_KEYS.publicKey });
});

app.post('/subscribe', (req, res) => {
  const { subscription, sessionId } = req.body;
  pushSubscriptions.set(sessionId, subscription);
  saveData();
  res.json({ ok: true });
});

app.post('/scrape', async (req, res) => {
  const { url, checkin, checkout, persons } = req.body;
  if (!url) return res.status(400).json({ error: 'URL manquante' });

  const cacheKey = `${url}|${checkin}|${checkout}|${persons}`;
  try {
    if (hotelCache.has(cacheKey)) {
      return res.json(hotelCache.get(cacheKey));
    }
    const data = await scrapeHotel(url, checkin, checkout, persons);
    hotelCache.set(cacheKey, data);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function createWatcher({ url, roomId, roomName, hotelName, persons, sessionId, interval, checkin, checkout }) {
  const id = uuidv4();

  const watcher = { id, url, roomId, roomName, hotelName, persons, sessionId, interval: interval || 5, checkin: checkin || null, checkout: checkout || null, wasAvailable: false, lastCheck: null, lastData: null, createdAt: new Date().toISOString() };
  watchers.set(id, watcher);

  const job = cron.schedule(`*/${Math.max(1, parseInt(watcher.interval) || 5)} * * * *`, () => checkAvailability(id));
  watcher.job = job;

  saveData();

  const nights = (checkin && checkout) ? Math.round((new Date(checkout) - new Date(checkin)) / 86400000) : null;
  const datesStr = nights ? ` · ${checkin} → ${checkout} (${nights} nuit${nights > 1 ? 's' : ''})` : '';

  if (sessionId) {
    const sub = pushSubscriptions.get(sessionId);
    if (sub) {
      webpush.sendNotification(sub, JSON.stringify({
        title: '✅ Surveillance activée — ' + hotelName,
        body: `On vous recontacte dès que "${roomName}" se libère${datesStr}.`,
        url: url
      })).catch(() => {});
    }
  }
  sendTelegram(`✅ <b>Surveillance activée</b>\n${hotelName}\nOn vous recontacte dès que "${roomName}" se libère${datesStr}.`);

  return watcher;
}

app.post('/watch', (req, res) => {
  const watcher = createWatcher(req.body);
  const { job: _, ...watcherData } = watcher;
  res.json({ watcherId: watcher.id, watcher: watcherData });
});

app.delete('/watch/:id', (req, res) => {
  const watcher = watchers.get(req.params.id);
  if (watcher?.job) { try { watcher.job.stop(); } catch(e) {} }
  watchers.delete(req.params.id);
  saveData();
  res.json({ ok: true });
});

app.get('/watchers', (req, res) => {
  const result = [];
  watchers.forEach(w => {
    result.push({ id: w.id, url: w.url, roomName: w.roomName, hotelName: w.hotelName, persons: w.persons, interval: w.interval, checkin: w.checkin, checkout: w.checkout, lastCheck: w.lastCheck, lastData: w.lastData, createdAt: w.createdAt });
  });
  res.json(result);
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

loadData();

const PORT = 3737;
app.listen(PORT, () => console.log(`Hotel Tracker running on http://localhost:${PORT}`));

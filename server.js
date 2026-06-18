const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
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

// VAPID keys persistants
let VAPID_KEYS;
if (fs.existsSync(VAPID_FILE)) {
  VAPID_KEYS = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
} else {
  VAPID_KEYS = webpush.generateVAPIDKeys();
  fs.writeFileSync(VAPID_FILE, JSON.stringify(VAPID_KEYS));
}
webpush.setVapidDetails('mailto:hotel-tracker@local.com', VAPID_KEYS.publicKey, VAPID_KEYS.privateKey);

const watchers = new Map();
const pushSubscriptions = new Map();
const hotelCache = new Map();

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
    headless: 'new',
    executablePath: isCloud
      ? (process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome-stable')
      : 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage'],
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8' });

    const isBooking = url.includes('booking.com');
    const isHotels = url.includes('hotels.com') || url.includes('expedia.com');

    const targetUrl = isBooking ? buildBookingUrl(url, checkin, checkout, persons) : url;
    console.log('[SCRAPE] URL:', targetUrl);

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await new Promise(r => setTimeout(r, 5000));

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
  // Scroll progressif pour charger le tableau des chambres
  for (let i = 1; i <= 4; i++) {
    await page.evaluate(p => { try { window.scrollTo(0, document.body.scrollHeight * p); } catch(e){} }, i * 0.25);
    await new Promise(r => setTimeout(r, 1000));
  }
  await new Promise(r => setTimeout(r, 2000));

  const hotelName = await page.evaluate(() => {
    for (const s of ['[data-testid="property-name"]','h2.pp-header__title','h1[data-capla-component]','.hp__hotel-name','h1']) {
      const el = document.querySelector(s);
      if (el && el.innerText.trim()) return el.innerText.trim();
    }
    return document.title.split(/[–\-|]/)[0].trim();
  });

  const html = await page.content();
  require('fs').writeFileSync('debug-booking.html', html);
  const roomLinkCount = (html.match(/rt-name-link/g) || []).length;
  const pageTitle = await page.title();
  console.log('[DEBUG] Title:', pageTitle, '| HTML size:', html.length, '| rt-name-link count:', roomLinkCount);

  const rooms = await page.evaluate(() => {
    const clean = s => (s || '').replace(/\s+/g, ' ').trim();
    const seen = new Set();
    const result = [];

    // Tous les liens de type chambre : a[data-room-id]
    const roomLinks = document.querySelectorAll('a[data-room-id][id^="room_type_id_"]');

    roomLinks.forEach(link => {
      try {
        // Nom dans le span enfant
        const nameEl = link.querySelector('span.hprt-roomtype-icon-link, span');
        const name = clean(nameEl ? nameEl.textContent : link.textContent);
        if (!name || name.length < 2 || seen.has(name)) return;
        seen.add(name);

        const roomId = link.getAttribute('data-room-id');

        // Prix depuis le select de la même pièce
        let price = 'Voir le site';
        let available = false;
        const selects = document.querySelectorAll(`select[data-room-id="${roomId}"]`);
        selects.forEach(sel => {
          const opt1 = sel.querySelector('option[value="1"]');
          if (opt1) {
            available = true;
            const priceMatch = opt1.textContent.match(/[\d\s,.]+/g);
            if (priceMatch) {
              const nums = priceMatch.map(s => s.replace(/\s/g,'')).filter(s => s.length > 1);
              if (nums.length) price = nums[nums.length - 1] + ' ' + (opt1.textContent.match(/[€$£]|AED|USD|EUR/) || [''])[0];
            }
          }
        });

        // Capacité via les icônes personnes dans le même bloc
        const th = link.closest('th, td');
        const row = link.closest('tr');
        let maxPersons = 2;
        if (row) {
          const personIcons = row.querySelectorAll('.hprt-icon-person, [class*="adult"], [data-testid="adults-icon"]');
          if (personIcons.length) maxPersons = personIcons.length;
        }

        // Soldout
        const soldOut = row ? !!row.querySelector('.sold_out_room, .hprt-soldout-text, [class*="soldout"]') : false;
        if (soldOut) available = false;

        result.push({ name, price: price.trim() || 'Voir le site', maxPersons, available, id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-') });
      } catch(e) {}
    });

    // Fallback si rien trouvé : chercher les noms via data-room-name
    if (!result.length) {
      document.querySelectorAll('[data-room-name]').forEach(el => {
        try {
          const name = clean(el.getAttribute('data-room-name') || el.textContent);
          if (!name || seen.has(name)) return;
          seen.add(name);
          result.push({ name, price: 'Voir le site', maxPersons: 2, available: true, id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-') });
        } catch(e) {}
      });
    }

    return result;
  });

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
}

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

app.post('/watch', (req, res) => {
  const { url, roomId, roomName, hotelName, persons, sessionId, interval, checkin, checkout } = req.body;
  const id = uuidv4();

  const watcher = { id, url, roomId, roomName, hotelName, persons, sessionId, interval: interval || 5, checkin: checkin || null, checkout: checkout || null, wasAvailable: false, lastCheck: null, lastData: null, createdAt: new Date().toISOString() };
  watchers.set(id, watcher);

  const job = cron.schedule(`*/${Math.max(1, parseInt(watcher.interval) || 5)} * * * *`, () => checkAvailability(id));
  watcher.job = job;

  saveData();

  // Notif de confirmation immédiate
  const sub = pushSubscriptions.get(sessionId);
  if (sub) {
    const nights = (checkin && checkout) ? Math.round((new Date(checkout) - new Date(checkin)) / 86400000) : null;
    const datesStr = nights ? ` · ${checkin} → ${checkout} (${nights} nuit${nights > 1 ? 's' : ''})` : '';
    webpush.sendNotification(sub, JSON.stringify({
      title: '✅ Surveillance activée — ' + hotelName,
      body: `On vous recontacte dès que "${roomName}" se libère${datesStr}.`,
      url: url
    })).catch(() => {});
  }

  const { job: _, ...watcherData } = watcher;
  res.json({ watcherId: id, watcher: watcherData });
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

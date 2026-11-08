'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const TICK_MS = 3000;
const MIN = 60000;
const DAY = 24 * 60 * MIN;
const PUBLIC_DIR = path.join(__dirname, 'public');
const THRESHOLD = { warn: 70, crit: 85 };

const categories = ['Водоснабжение', 'Теплоснабжение', 'Электроснабжение'];
const prefixes = ['Насосная станция', 'Котельная', 'Подстанция'];
const MESSAGES = {
  high: ['Аварийное отключение узла', 'Падение давления ниже допустимого', 'Перегрузка основного контура'],
  medium: ['Отклонение параметров от нормы', 'Сбой датчика телеметрии', 'Превышение порога нагрузки'],
  low: ['Плановое отклонение показателей', 'Кратковременная потеря сигнала', 'Требуется осмотр оборудования'],
};

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (list) => list[Math.floor(Math.random() * list.length)];

const objects = [];
categories.forEach((category, c) => {
  for (let i = 1; i <= 4; i++) {
    objects.push({
      id: c * 4 + i,
      category,
      name: `${prefixes[c]} №${i}`,
      base: rand(45, 65),
      phase: rand(0, 6.28),
      surgeUntil: 0,
    });
  }
});

function loadAt(o, t) {
  const surge = o.surgeUntil > t ? 22 : 0;
  const raw = o.base + 14 * Math.sin((2 * Math.PI * (t % DAY)) / DAY + o.phase) + rand(-4, 4) + surge;
  return Math.round(Math.max(3, Math.min(100, raw)) * 10) / 10;
}

let nextId = 1;
function createIncident(t) {
  const o = pick(objects);
  const r = Math.random();
  const severity = r < 0.15 ? 'high' : r < 0.5 ? 'medium' : 'low';
  const duration = rand(2, 25) * MIN;
  return {
    id: nextId++, ts: t, o: o.id, severity,
    message: pick(MESSAGES[severity]),
    status: 'open', resolveAt: t + duration, resolvedAt: null, upd: t,
  };
}

let points = [];
let incidents = [];

function seed() {
  const now = Date.now();
  for (let t = now - DAY; t <= now; t += MIN) {
    objects.forEach((o) => points.push({ t, o: o.id, v: loadAt(o, t) }));
  }
  for (let i = 0; i < 40; i++) {
    const inc = createIncident(now - rand(5, 24 * 60) * MIN);
    if (inc.resolveAt <= now) {
      inc.status = 'resolved';
      inc.resolvedAt = inc.resolveAt;
      inc.upd = inc.resolveAt;
    }
    incidents.push(inc);
  }
  incidents.sort((a, b) => a.ts - b.ts);
}

const clients = new Set();

function broadcast(event, payload) {
  const message = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  clients.forEach((res) => res.write(message));
}

function tick() {
  const t = Date.now();
  const values = objects.map((o) => ({ t, o: o.id, v: loadAt(o, t) }));
  points.push(...values);
  const changed = [];
  if (Math.random() < 0.05) {
    const inc = createIncident(t);
    if (inc.severity !== 'low') objects.find((o) => o.id === inc.o).surgeUntil = inc.resolveAt;
    incidents.push(inc);
    changed.push(inc);
  }
  incidents.forEach((inc) => {
    if (inc.status === 'open' && inc.resolveAt <= t) {
      inc.status = 'resolved';
      inc.resolvedAt = t;
      inc.upd = t;
      changed.push(inc);
    }
  });
  const cut = t - DAY;
  let k = 0;
  while (k < points.length && points[k].t < cut) k++;
  if (k) points.splice(0, k);
  incidents = incidents.filter((inc) => inc.ts >= cut);
  broadcast('tick', { t, points: values, incidents: changed });
}

function send(res, code, body, type) {
  res.writeHead(code, {
    'Content-Type': type || 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; connect-src 'self'",
  });
  res.end(body);
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

function serveStatic(res, pathname) {
  let rel;
  try {
    rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  } catch {
    return send(res, 400, 'Bad request', 'text/plain');
  }
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !TYPES[path.extname(file)]) {
    return send(res, 404, 'Not found', 'text/plain');
  }
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found', 'text/plain');
    send(res, 200, data, TYPES[path.extname(file)]);
  });
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', 'text/plain');
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api/meta') {
    return send(res, 200, JSON.stringify({
      categories,
      objects: objects.map(({ id, name, category }) => ({ id, name, category })),
      threshold: THRESHOLD,
      tickMs: TICK_MS,
    }));
  }

  if (url.pathname === '/api/history') {
    const since = Number(url.searchParams.get('since')) || 0;
    return send(res, 200, JSON.stringify({
      now: Date.now(),
      points: points.filter((p) => p.t > since),
      incidents: incidents.filter((i) => i.upd > since),
    }));
  }

  if (url.pathname === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  serveStatic(res, url.pathname);
});

seed();
setInterval(tick, TICK_MS);
server.listen(PORT, () => console.log(`http://localhost:${PORT}`));

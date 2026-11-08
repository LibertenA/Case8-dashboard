(function () {
'use strict';

const { useState, useEffect, useMemo, useRef } = React;
const h = React.createElement;

const DAY = 86400000;
const PERIODS = [
  { id: '15m', label: '15 минут', ms: 15 * 60000, buckets: 15 },
  { id: '1h', label: '1 час', ms: 3600000, buckets: 20 },
  { id: '6h', label: '6 часов', ms: 6 * 3600000, buckets: 24 },
  { id: '24h', label: '24 часа', ms: DAY, buckets: 24 },
];
const SEVERITY = { high: 'Критический', medium: 'Серьезный', low: 'Незначительный' };
const STATUS = { open: 'Открыт', resolved: 'Устранен' };

const timeFmt = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const shortFmt = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });

async function getJson(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(String(response.status));
  return response.json();
}

function createStream({ onState, onSync, onTick }) {
  let source = null;
  let retryTimer = null;
  let watchTimer = null;
  let attempt = 0;
  let stopped = false;
  let wasLost = false;

  const clear = () => {
    clearTimeout(retryTimer);
    clearTimeout(watchTimer);
    if (source) {
      source.close();
      source = null;
    }
  };

  const lose = (delay) => {
    clear();
    if (stopped) return;
    wasLost = true;
    attempt += 1;
    onState('lost', attempt);
    retryTimer = setTimeout(open, delay === undefined ? Math.min(1000 * 2 ** attempt, 10000) : delay);
  };

  const arm = () => {
    clearTimeout(watchTimer);
    watchTimer = setTimeout(() => lose(), 10000);
  };

  function open() {
    clear();
    if (stopped) return;
    onState('connecting', attempt);
    source = new EventSource('/api/stream');
    source.onopen = async () => {
      try {
        await onSync();
      } catch {
        lose();
        return;
      }
      attempt = 0;
      arm();
      onState(wasLost ? 'restored' : 'online', 0);
      wasLost = false;
    };
    source.addEventListener('tick', (event) => {
      arm();
      onTick(JSON.parse(event.data));
    });
    source.onerror = () => lose();
  }

  open();
  return { drop: () => lose(7000), stop: () => { stopped = true; clear(); } };
}

function ChartView({ type, data, options, label }) {
  const canvas = useRef(null);
  const chart = useRef(null);
  useEffect(() => {
    chart.current = new window.Chart(canvas.current, {
      type,
      data,
      options: { ...options, animation: false, maintainAspectRatio: false, responsive: true },
    });
    return () => chart.current.destroy();
  }, []);
  useEffect(() => {
    chart.current.data = data;
    chart.current.update('none');
  }, [data]);
  return h('div', { className: 'chart' }, h('canvas', { ref: canvas, role: 'img', 'aria-label': label }));
}

function Kpi({ label, value, level }) {
  return h('div', { className: 'card kpi' },
    h('div', { className: 'label' }, label),
    h('div', { className: 'value ' + (level || '') }, value));
}

function compute(meta, points, incidents, filters, now) {
  const period = PERIODS.find((p) => p.id === filters.period);
  const from = now - period.ms;
  const objs = meta.objects.filter((o) =>
    (filters.category === 'all' || o.category === filters.category) &&
    (filters.object === 'all' || String(o.id) === filters.object));
  const ids = new Set(objs.map((o) => o.id));
  const names = new Map(meta.objects.map((o) => [o.id, o]));

  const sums = new Array(period.buckets).fill(0);
  const counts = new Array(period.buckets).fill(0);
  const objSum = new Map(objs.map((o) => [o.id, 0]));
  const objCount = new Map(objs.map((o) => [o.id, 0]));
  const latest = new Map();
  const size = period.ms / period.buckets;
  let total = 0;
  let count = 0;

  points.forEach((p) => {
    if (!ids.has(p.o)) return;
    latest.set(p.o, p.v);
    if (p.t <= from) return;
    const idx = Math.min(period.buckets - 1, Math.floor((p.t - from) / size));
    sums[idx] += p.v;
    counts[idx] += 1;
    objSum.set(p.o, objSum.get(p.o) + p.v);
    objCount.set(p.o, objCount.get(p.o) + 1);
    total += p.v;
    count += 1;
  });

  const scoped = incidents.filter((i) => ids.has(i.o));
  const open = scoped.filter((i) => i.status === 'open');
  const inPeriod = scoped.filter((i) => i.ts > from).sort((a, b) => b.ts - a.ts);
  const resolved = inPeriod.filter((i) => i.status === 'resolved');
  const openIds = new Set(open.map((i) => i.o));
  const normal = objs.filter((o) => (latest.get(o.id) || 0) <= meta.threshold.crit && !openIds.has(o.id)).length;

  return {
    objs, names, inPeriod, open,
    avgLoad: count ? total / count : null,
    normal,
    avgResolve: resolved.length ? resolved.reduce((s, i) => s + (i.resolvedAt - i.ts), 0) / resolved.length / 60000 : null,
    labels: sums.map((_, i) => shortFmt.format(from + i * size)),
    series: sums.map((s, i) => (counts[i] ? Math.round((s / counts[i]) * 10) / 10 : null)),
    barLabels: objs.map((o) => o.name),
    barValues: objs.map((o) => (objCount.get(o.id) ? Math.round((objSum.get(o.id) / objCount.get(o.id)) * 10) / 10 : 0)),
  };
}

function App() {
  const [meta, setMeta] = useState(null);
  const [points, setPoints] = useState([]);
  const [incidents, setIncidents] = useState([]);
  const [now, setNow] = useState(Date.now());
  const [conn, setConn] = useState({ state: 'connecting', attempt: 0 });
  const [filters, setFilters] = useState({ period: '1h', category: 'all', object: 'all' });
  const metaRef = useRef(null);
  const sinceRef = useRef(0);
  const readyRef = useRef(false);
  const streamRef = useRef(null);

  const apply = (newPoints, changed, t) => {
    sinceRef.current = t;
    setNow(t);
    if (newPoints.length) setPoints((prev) => prev.concat(newPoints).filter((p) => p.t > t - DAY));
    if (changed.length) {
      setIncidents((prev) => {
        const map = new Map(prev.map((i) => [i.id, i]));
        changed.forEach((i) => map.set(i.id, i));
        return Array.from(map.values()).filter((i) => i.ts > t - DAY);
      });
    }
  };

  useEffect(() => {
    streamRef.current = createStream({
      onState: (state, attempt) => {
        if (state === 'lost' || state === 'connecting') readyRef.current = false;
        setConn({ state, attempt });
      },
      onSync: async () => {
        if (!metaRef.current) {
          metaRef.current = await getJson('/api/meta');
          setMeta(metaRef.current);
        }
        const data = await getJson('/api/history?since=' + sinceRef.current);
        apply(data.points, data.incidents, data.now);
        readyRef.current = true;
      },
      onTick: (message) => {
        if (readyRef.current) apply(message.points, message.incidents, message.t);
      },
    });
    return () => streamRef.current.stop();
  }, []);

  useEffect(() => {
    if (conn.state !== 'restored') return undefined;
    const timer = setTimeout(() => setConn({ state: 'online', attempt: 0 }), 4000);
    return () => clearTimeout(timer);
  }, [conn.state]);

  const view = useMemo(
    () => (meta ? compute(meta, points, incidents, filters, now) : null),
    [meta, points, incidents, filters, now],
  );

  const setFilter = (key, value) =>
    setFilters((prev) => ({ ...prev, [key]: value, ...(key === 'category' ? { object: 'all' } : {}) }));

  const bannerText = {
    lost: `Соединение потеряно. Данные не обновляются, повторная попытка (${conn.attempt}). Последнее обновление: ${timeFmt.format(now)}`,
    connecting: 'Подключение к серверу данных',
    restored: 'Соединение восстановлено, данные синхронизированы',
  }[conn.state];

  const objectOptions = meta ? meta.objects.filter((o) => filters.category === 'all' || o.category === filters.category) : [];
  const stale = conn.state === 'lost' || conn.state === 'connecting';
  const crit = meta ? meta.threshold.crit : 85;
  const warn = meta ? meta.threshold.warn : 70;

  const select = (label, key, options) =>
    h('label', null, label,
      h('select', { value: filters[key], onChange: (e) => setFilter(key, e.target.value) },
        options.map((o) => h('option', { key: o.value, value: o.value }, o.label))));

  return h(React.Fragment, null,
    h('header', null,
      h('div', null,
        h('h1', null, 'Диспетчерский дашборд инженерной инфраструктуры'),
        h('div', { className: 'updated' }, meta ? 'Обновлено: ' + timeFmt.format(now) : 'Загрузка данных')),
      h('div', { className: 'filters' },
        select('Период', 'period', PERIODS.map((p) => ({ value: p.id, label: p.label }))),
        select('Категория', 'category', [{ value: 'all', label: 'Все категории' }].concat(
          (meta ? meta.categories : []).map((c) => ({ value: c, label: c })))),
        select('Объект', 'object', [{ value: 'all', label: 'Все объекты' }].concat(
          objectOptions.map((o) => ({ value: String(o.id), label: o.name })))),
        h('label', null, '\u00a0',
          h('button', { type: 'button', onClick: () => streamRef.current.drop(), disabled: stale }, 'Имитировать обрыв связи')))),
    bannerText && h('div', { className: 'banner ' + conn.state, role: 'status', 'aria-live': 'polite' }, bannerText),
    view && h('main', { className: stale ? 'stale' : '' },
      h('section', { className: 'kpis' },
        h(Kpi, { label: 'Объектов в норме', value: `${view.normal} из ${view.objs.length}`, level: view.normal < view.objs.length ? 'warn' : '' }),
        h(Kpi, { label: 'Средняя нагрузка', value: view.avgLoad === null ? 'нет данных' : view.avgLoad.toFixed(1) + ' %', level: view.avgLoad > crit ? 'crit' : view.avgLoad > warn ? 'warn' : '' }),
        h(Kpi, { label: 'Открытые инциденты', value: view.open.length, level: view.open.length ? 'crit' : '' }),
        h(Kpi, { label: 'Инцидентов за период', value: view.inPeriod.length }),
        h(Kpi, { label: 'Среднее время устранения', value: view.avgResolve === null ? 'нет данных' : view.avgResolve.toFixed(1) + ' мин' })),
      h('section', { className: 'charts' },
        h('div', { className: 'card' },
          h('h2', null, 'Динамика средней нагрузки, %'),
          h(ChartView, {
            label: 'Линейный график средней нагрузки по времени',
            type: 'line',
            data: {
              labels: view.labels,
              datasets: [
                { label: 'Нагрузка', data: view.series, borderColor: '#2f6fb3', backgroundColor: '#2f6fb3', tension: 0.25, pointRadius: 2, spanGaps: true },
                { label: 'Порог', data: view.labels.map(() => crit), borderColor: '#d64545', borderDash: [6, 4], pointRadius: 0 },
              ],
            },
            options: { scales: { y: { min: 0, max: 100 } }, plugins: { legend: { position: 'bottom' } } },
          })),
        h('div', { className: 'card' },
          h('h2', null, 'Нагрузка по объектам, %'),
          h(ChartView, {
            label: 'Столбчатая диаграмма нагрузки по объектам',
            type: 'bar',
            data: {
              labels: view.barLabels,
              datasets: [{
                label: 'Средняя нагрузка',
                data: view.barValues,
                backgroundColor: view.barValues.map((v) => (v > crit ? '#d64545' : v > warn ? '#d4891c' : '#2f6fb3')),
              }],
            },
            options: { scales: { y: { min: 0, max: 100 } }, plugins: { legend: { display: false } } },
          }))),
      h('section', { className: 'card' },
        h('h2', null, 'Последние события и инциденты'),
        view.inPeriod.length === 0
          ? h('div', { className: 'empty' }, 'За выбранный период событий нет')
          : h('div', { className: 'table-wrap' },
            h('table', null,
              h('thead', null, h('tr', null, ['Время', 'Объект', 'Категория', 'Уровень', 'Описание', 'Статус'].map((t) => h('th', { key: t }, t)))),
              h('tbody', null, view.inPeriod.slice(0, 12).map((i) => {
                const obj = view.names.get(i.o);
                return h('tr', { key: i.id },
                  h('td', null, timeFmt.format(i.ts)),
                  h('td', null, obj.name),
                  h('td', null, obj.category),
                  h('td', null, h('span', { className: 'tag ' + i.severity }, SEVERITY[i.severity])),
                  h('td', null, i.message),
                  h('td', { className: 'status-' + i.status }, STATUS[i.status]));
              })))))));
}

class Boundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return h('div', { className: 'banner lost', role: 'alert' }, 'Ошибка отображения. Обновите страницу.');
    }
    return this.props.children;
  }
}

const css = getComputedStyle(document.documentElement);
window.Chart.defaults.color = css.getPropertyValue('--muted').trim();
window.Chart.defaults.borderColor = css.getPropertyValue('--line').trim();

ReactDOM.createRoot(document.getElementById('root')).render(h(Boundary, null, h(App)));
})();

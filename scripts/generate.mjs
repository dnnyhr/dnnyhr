// Genera las tarjetas del perfil (stats, langs, activity, github-snake) en versión clara y oscura.
// Uso: GH_TOKEN=... node scripts/generate.mjs  → escribe los SVG en ./dist
// Sin dependencias: Node 20+ (usa fetch nativo).
import { mkdir, writeFile, readFile } from 'node:fs/promises';

const LOGIN = process.env.GH_LOGIN || 'dnnyhr';
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const TZ = process.env.PROFILE_TZ || 'America/Managua';
const OUT = process.env.OUT_DIR || 'dist';

const THEMES = {
  light: {
    fg: '#1c1a17', mu: '#6b645a', ac: '#94601c', line: '#ddd6cb', bar: '#c4a882',
    langs: ['#94601c', '#a3763c', '#b28d5c', '#c1a37b', '#d0b99b', '#dfcfbb'],
    levels: ['#efebe4', '#d6c4ac', '#c0a37c', '#aa814c', '#94601c'],
  },
  dark: {
    fg: '#f0ebe3', mu: '#a39d93', ac: '#d6a66a', line: '#3a3631', bar: '#7c6345',
    langs: ['#d6a66a', '#ba915e', '#9e7c53', '#826747', '#65533c', '#493e30'],
    levels: ['#1b1e23', '#4f4437', '#7c6548', '#a98559', '#d6a66a'],
  },
};

const LEVEL = { NONE: 0, FIRST_QUARTILE: 1, SECOND_QUARTILE: 2, THIRD_QUARTILE: 3, FOURTH_QUARTILE: 4 };
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

// ───────────────────────── datos ─────────────────────────

async function gql(query, variables) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `bearer ${TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': LOGIN },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) throw new Error(`GraphQL ${res.status}: ${JSON.stringify(json.errors || json)}`);
  return json.data;
}

const DAYS = `contributionCalendar { totalContributions weeks { contributionDays { date contributionCount contributionLevel } } }`;

async function fetchData() {
  const now = new Date();
  const yearStart = `${now.getUTCFullYear()}-01-01T00:00:00Z`;
  const base = await gql(
    `query($login:String!,$from:DateTime!){user(login:$login){
      thisYear: contributionsCollection(from:$from){ totalCommitContributions totalPullRequestContributions }
      lastYear: contributionsCollection{ contributionYears ${DAYS} }
    }}`,
    { login: LOGIN, from: yearStart },
  );
  const user = base.user;
  const lastYear = user.lastYear.contributionCalendar;

  // Días de todos los años (para la racha máxima histórica).
  const days = new Map();
  const addWeeks = (weeks) => weeks.forEach((w) => w.contributionDays.forEach((d) => days.set(d.date, d)));
  for (const year of user.lastYear.contributionYears) {
    const y = await gql(
      `query($login:String!,$from:DateTime!,$to:DateTime!){user(login:$login){contributionsCollection(from:$from,to:$to){${DAYS}}}}`,
      { login: LOGIN, from: `${year}-01-01T00:00:00Z`, to: `${year}-12-31T23:59:59Z` },
    );
    addWeeks(y.user.contributionsCollection.contributionCalendar.weeks);
  }
  addWeeks(lastYear.weeks);

  // Estrellas y lenguajes de repos propios (no forks).
  let stars = 0;
  const langs = new Map();
  let cursor = null;
  do {
    const r = await gql(
      `query($login:String!,$cursor:String){user(login:$login){repositories(first:100,after:$cursor,ownerAffiliations:OWNER,isFork:false){
        pageInfo{hasNextPage endCursor}
        nodes{ stargazerCount languages(first:20,orderBy:{field:SIZE,direction:DESC}){ edges{ size node{ name } } } }
      }}}`,
      { login: LOGIN, cursor },
    );
    const repos = r.user.repositories;
    for (const repo of repos.nodes) {
      stars += repo.stargazerCount;
      for (const e of repo.languages.edges) langs.set(e.node.name, (langs.get(e.node.name) || 0) + e.size);
    }
    cursor = repos.pageInfo.hasNextPage ? repos.pageInfo.endCursor : null;
  } while (cursor);

  return {
    generatedAt: now.toISOString(),
    totalLastYear: lastYear.totalContributions,
    calendar: lastYear.weeks.map((w) => w.contributionDays),
    allDays: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)),
    commitsThisYear: user.thisYear.totalCommitContributions,
    prsThisYear: user.thisYear.totalPullRequestContributions,
    stars,
    langs: [...langs.entries()].map(([name, size]) => ({ name, size })).sort((a, b) => b.size - a.size),
  };
}

function streaks(allDays, lastDate) {
  const days = allDays.filter((d) => d.date <= lastDate);
  let max = 0, run = 0;
  for (const d of days) {
    run = d.contributionCount > 0 ? run + 1 : 0;
    max = Math.max(max, run);
  }
  // La racha actual sigue viva si hoy aún no hay contribuciones pero ayer sí.
  let i = days.length - 1;
  if (i >= 0 && days[i].contributionCount === 0) i--;
  let current = 0;
  while (i >= 0 && days[i].contributionCount > 0) { current++; i--; }
  return { current, max };
}

// ───────────────────────── SVG ─────────────────────────

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
const f1 = (n) => n.toFixed(1);
const dias = (n) => `${n} ${n === 1 ? 'día' : 'días'}`;
const shortDate = (iso) => { const [, m, d] = iso.split('-').map(Number); return `${d} ${MONTHS[m - 1]}`; };

function style(t) {
  return `<style>text{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans',Helvetica,Arial,sans-serif}.d{font-family:'Iowan Old Style','Palatino Linotype',Palatino,'Book Antiqua',Georgia,serif}.m{font-family:ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,monospace}.fg{fill:${t.fg}}.mu{fill:${t.mu}}.ac{fill:${t.ac}}
.up{animation:up .9s cubic-bezier(.2,.8,.2,1) both}.dr{stroke-dasharray:1;animation:dr 1.4s cubic-bezier(.65,0,.35,1) both}
.gr{transform-box:fill-box;transform-origin:50% 100%;animation:gr .9s cubic-bezier(.2,.8,.2,1) both}
.sx{transform-box:fill-box;transform-origin:0 50%;animation:sx 1.2s cubic-bezier(.65,0,.35,1) both}
@keyframes up{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
@keyframes dr{from{stroke-dashoffset:1}to{stroke-dashoffset:0}}
@keyframes gr{from{transform:scaleY(0)}to{transform:none}}
@keyframes sx{from{transform:scaleX(0)}to{transform:none}}
@media (prefers-reduced-motion:reduce){*{animation:none!important}}</style>`;
}

const svg = (w, h, label, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" fill="none" role="img" aria-label="${esc(label)}"><title>${esc(label)}</title>${body}</svg>\n`;

const delay = (s) => `style="animation-delay:${s.toFixed(2)}s"`;

function statsCard(t, data) {
  const lastDate = data.calendar.at(-1).at(-1).date;
  const { current, max } = streaks(data.allDays, lastDate);
  const updated = new Intl.DateTimeFormat('es', { day: 'numeric', month: 'long', year: 'numeric', timeZone: TZ }).format(new Date(data.generatedAt));
  const cols = [
    ['CONTRIBUCIONES', data.totalLastYear, 'últimos 12 meses'],
    ['COMMITS', data.commitsThisYear, 'este año'],
    ['PULL REQUESTS', data.prsThisYear, 'este año'],
    ['ESTRELLAS', data.stars, 'en repos propios'],
    ['RACHA ACTUAL', dias(current), `máx. ${dias(max)}`],
  ];
  let body = style(t) + `<path d="M0 1H850" stroke="${t.fg}" pathLength="1" class="dr" ${delay(0)}/>`;
  cols.forEach(([label, value, sub], i) => {
    const x = i * 172, d = 0.15 + i * 0.1, streak = i === cols.length - 1;
    body += `<text x="${x}" y="30" font-size="9.5" letter-spacing="1.8" class="m mu up" ${delay(d)}>${label}</text>
<text x="${x - 2}" y="80" font-size="${streak ? 34 : 44}" letter-spacing="-1" class="d ${streak ? 'ac' : 'fg'} up" ${delay(d + 0.06)}>${esc(value)}</text>
<text x="${x}" y="104" font-size="12.5" font-style="italic" class="d mu up" ${delay(d + 0.12)}>${esc(sub)}</text>`;
    if (i > 0) body += `<path d="M${x - 16} 20V108" stroke="${t.line}" pathLength="1" class="dr" ${delay(d)}/>`;
  });
  body += `<path d="M0 128H850" stroke="${t.line}" pathLength="1" class="dr" ${delay(0.4)}/><text x="0" y="150" font-size="11.5" font-style="italic" class="d mu up" ${delay(0.9)}>Actualizado el ${esc(updated)} · se regenera cada 12 horas.</text>
<text x="850" y="150" font-size="9.5" letter-spacing="1.6" text-anchor="end" class="m mu up" ${delay(0.95)}>@${esc(LOGIN.toUpperCase())}</text>`;
  return svg(850, 158, 'Estadísticas de GitHub', body);
}

function langsCard(t, data) {
  const total = data.langs.reduce((s, l) => s + l.size, 0);
  let items = data.langs.slice(0, 6);
  if (data.langs.length > 6) {
    items = data.langs.slice(0, 5);
    items.push({ name: 'Otros', size: data.langs.slice(5).reduce((s, l) => s + l.size, 0) });
  }
  let body = style(t) + `<text x="0" y="22" font-size="22" class="d fg up">Lenguajes</text><text x="850" y="20" font-size="9.5" letter-spacing="1.8" text-anchor="end" class="m mu up">LANGUAGES · POR TAMAÑO DE CÓDIGO</text>`;
  if (!total) return svg(850, 106, 'Lenguajes más usados', body + `<text x="0" y="77" font-size="14" class="mu up">Sin datos todavía</text>`);
  const gap = 2, usable = 850 - gap * (items.length - 1);
  let x = 0;
  items.forEach((l, i) => {
    const w = i === items.length - 1 ? 850 - x : (l.size / total) * usable;
    body += `<rect x="${f1(x)}" y="40" width="${f1(w)}" height="6" fill="${t.langs[i]}" class="sx" ${delay(0.2 + i * 0.08)}/>`;
    x += w + gap;
  });
  items.forEach((l, i) => {
    const lx = +(i * (850 / 6)).toFixed(2), d = 0.5 + i * 0.07;
    body += `<rect x="${lx}" y="68" width="8" height="8" fill="${t.langs[i]}" class="up" ${delay(d)}/>
<text x="${lx + 16}" y="77" font-size="14" class="fg up" ${delay(d)}>${esc(l.name)}</text>
<text x="${lx + 16}" y="96" font-size="10.5" class="m mu up" ${delay(d + 0.05)}>${f1((l.size / total) * 100)}%</text>`;
  });
  return svg(850, 106, 'Lenguajes más usados', body);
}

function activityCard(t, data) {
  const days = data.calendar.flat().slice(-31);
  const max = Math.max(1, ...days.map((d) => d.contributionCount));
  const sum = days.reduce((s, d) => s + d.contributionCount, 0);
  const step = 850 / days.length, bw = 15.4;
  let body = style(t) + `<text x="0" y="22" font-size="22" class="d fg up">Actividad</text><text x="850" y="20" font-size="9.5" letter-spacing="1.8" text-anchor="end" class="m mu up">ÚLTIMOS 31 DÍAS · LAST 31 DAYS</text><text x="0" y="48" font-size="9.5" class="m mu up" ${delay(0.2)}>${max}</text><path d="M24 44H850" stroke="${t.line}" stroke-dasharray="2 5"/>`;
  days.forEach((d, i) => {
    const v = d.contributionCount, h = v ? (v / max) * 110 : 1;
    const fill = !v ? t.line : v === max ? t.ac : t.bar;
    body += `<rect x="${f1(6 + i * step)}" y="${f1(154 - h)}" width="${bw}" height="${f1(h)}" fill="${fill}" class="gr" ${delay(0.25 + i * 0.025)}><title>${esc(shortDate(d.date))}: ${v}</title></rect>`;
  });
  body += `<path d="M0 154.5H850" stroke="${t.fg}" pathLength="1" class="dr" ${delay(0.1)}/><text x="0" y="176" font-size="12" font-style="italic" class="d mu up" ${delay(1)}>${shortDate(days[0].date)}</text>
<text x="425" y="176" font-size="12" font-style="italic" text-anchor="middle" class="d mu up" ${delay(1)}>${sum} ${sum === 1 ? 'contribución' : 'contribuciones'}</text>
<text x="850" y="176" font-size="12" font-style="italic" text-anchor="end" class="d mu up" ${delay(1)}>${shortDate(days.at(-1).date)}</text>`;
  return svg(850, 186, 'Actividad de los últimos 31 días', body);
}

function snakeCard(t, data) {
  // Columnas = semanas; la primera puede venir incompleta, así que se rellenan huecos por día de la semana.
  const weeks = data.calendar.slice(-52);
  const pitch = 15.6, cell = 12, dur = 40;
  const x0 = (850 - ((weeks.length - 1) * pitch + cell)) / 2, y0 = 6;
  const cells = [];
  weeks.forEach((week, c) => {
    const byDow = new Map(week.map((d) => [new Date(`${d.date}T00:00:00Z`).getUTCDay(), d]));
    const rows = [...Array(7).keys()];
    if (c % 2) rows.reverse(); // recorrido en zigzag, columna a columna
    for (const r of rows) cells.push({ x: x0 + c * pitch, y: y0 + r * pitch, day: byDow.get(r) });
  });
  const n = cells.length, t0 = 0.01, t1 = 0.94;
  let body = '';
  cells.forEach((p, k) => {
    const lvl = p.day ? LEVEL[p.day.contributionLevel] ?? 0 : 0;
    const fill = t.levels[lvl];
    const rect = `<rect x="${f1(p.x)}" y="${f1(p.y)}" width="${cell}" height="${cell}" rx="2" fill="${fill}"`;
    if (!lvl) { body += `${rect}/>`; return; }
    const eat = (t0 + (k / (n - 1)) * (t1 - t0)).toFixed(4);
    body += `${rect}><animate attributeName="fill" values="${fill};${t.levels[0]};${t.levels[0]};${fill}" keyTimes="0;${eat};.97;1" calcMode="discrete" dur="${dur}s" repeatCount="indefinite"/></rect>`;
  });
  const path = 'M' + cells.map((p) => `${f1(p.x + cell / 2)} ${f1(p.y + cell / 2)}`).join('L');
  const motion = (begin) => `<animateMotion path="${path}" dur="${dur}s" keyPoints="0;0;1;1" keyTimes="0;${t0};${t1};1" calcMode="linear" begin="${begin.toFixed(2)}s" repeatCount="indefinite"/>`;
  // Cola (7 segmentos que se desvanecen) y cabeza.
  for (let i = 7; i >= 1; i--) {
    const s = cell - i * 0.6, o = 1 - i * 0.1;
    body += `<rect x="${f1(-s / 2)}" y="${f1(-s / 2)}" width="${+s.toFixed(1)}" height="${+s.toFixed(1)}" rx="2" fill="${t.ac}" opacity="${o.toFixed(2)}">${motion(i * 0.1)}</rect>`;
  }
  body += `<rect x="-6" y="-6" width="12" height="12" rx="3" fill="${t.fg}" opacity="1.00">${motion(0)}</rect>`;
  return svg(850, 118, 'Contribuciones', body);
}

// ───────────────────────── main ─────────────────────────

const data = process.env.DATA_FILE
  ? JSON.parse(await readFile(process.env.DATA_FILE, 'utf8'))
  : TOKEN ? await fetchData() : (console.error('Falta GH_TOKEN'), process.exit(1));

await mkdir(OUT, { recursive: true });
const cards = { stats: statsCard, langs: langsCard, activity: activityCard, 'github-snake': snakeCard };
for (const [name, render] of Object.entries(cards)) {
  await writeFile(`${OUT}/${name}.svg`, render(THEMES.light, data));
  await writeFile(`${OUT}/${name}-dark.svg`, render(THEMES.dark, data));
}
console.log(`OK · ${data.totalLastYear} contribuciones · ${data.langs.length} lenguajes · ${Object.keys(cards).length * 2} SVG en ${OUT}/`);

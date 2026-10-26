// =====================================================================
//  이스라엘 총선(제26대 크네세트) 개표 API — Cloudflare Worker
// =====================================================================
//
//  엔드포인트 (모두 GET, CORS 허용, JSON)
//    /api                  사용 가능한 엔드포인트 목록
//    /api/results          전국 집계: 개표율·투표율·정당별 득표·예상 의석·여야 합계
//    /api/localities       지역(ishuv)별 결과 목록   ?sort=voters|name  ?limit=50
//    /api/locality         한 지역 결과              ?code=5000  또는  ?name=תל אביב
//    /api/parties          정당 목록(기호·이름·대표·블록·잔여표 합의)
//    /api/polls            여론조사 평균(중동포럼 poll-of-polls 중계)
//    /files/expc.csv       선관위 원본 CSV 중계
//
//  데이터 출처 (환경 변수 SOURCE 로 선택)
//    relay (기본)  johnnoto/israel-election-watcher 의 live.json
//                  — 선관위가 클라우드 서버를 막아서, 개인 맥에서 받아 GitHub에 올리는 비공식 중계
//    cec           선관위 원본 CSV 직접 (media26.bechirot.gov.il/files/expc.csv)
//                  — 워커 IP가 차단되면 동작하지 않음
//
//  필드 이름은 이스라엘 선거 공개 데이터 관례(ishuv, voters …)를 따름.
// =====================================================================

const RELAY_URL = 'https://raw.githubusercontent.com/johnnoto/israel-election-watcher/main/data/live.json';
const CEC_HOST = 'https://media26.bechirot.gov.il';
const POLLS_URL = 'https://israelvote.meforum.org/data/poll_of_polls.json';
const CACHE_SECONDS = 30;

const SEATS = 120, THRESHOLD = 0.0325, ELIGIBLE_TOTAL = 7331981;

// 투표용지 기호 → 정당 정보 (bloc: gov 여당 / opp 야당)
const PARTIES = {
  'מחל': { id: 'likud',      ko: '리쿠드',               en: 'Likud',                   leader: '네타냐후',   bloc: 'gov' },
  'ב':   { id: 'otzma',      ko: '오츠마 예후디트',       en: 'Otzma Yehudit',           leader: '벤그비르',   bloc: 'gov' },
  'ט':   { id: 'rzp',        ko: '종교시온주의당·제후트', en: 'Religious Zionism–Zehut', leader: '스모트리치', bloc: 'gov' },
  'שס':  { id: 'shas',       ko: '샤스',                 en: 'Shas',                    leader: '데리',       bloc: 'gov' },
  'ג':   { id: 'utj',        ko: '토라유대교연합',        en: 'United Torah Judaism',    leader: '골드크노프', bloc: 'gov' },
  'רק':  { id: 'together',   ko: '베야하드',             en: 'Together',                leader: '베네트',     bloc: 'opp' },
  'דרך': { id: 'yashar',     ko: '야샤르',               en: 'Yashar',                  leader: '아이젠코트', bloc: 'opp' },
  'כן':  { id: 'bluewhite',  ko: '청백당',               en: 'Blue and White',          leader: '간츠',       bloc: 'opp' },
  'אמת': { id: 'democrats',  ko: '민주당',               en: 'The Democrats',           leader: '골란',       bloc: 'opp' },
  'ל':   { id: 'yb',         ko: '이스라엘 베이테누',     en: 'Yisrael Beiteinu',        leader: '리베르만',   bloc: 'opp' },
  'די':  { id: 'reservists', ko: '예비군·경제당',         en: 'The Reservists',          leader: '헨델',       bloc: 'opp' },
  'ך':   { id: 'amcha',      ko: '암차 이스라엘',         en: 'Amcha Yisrael',           leader: '빈터',       bloc: 'opp' },
  'ודם': { id: 'joint',      ko: '공동명부',             en: 'Joint List',              leader: '자바린',     bloc: 'opp' },
  'עם':  { id: 'raam',       ko: '라암',                 en: "Ra'am",                   leader: '압바스',     bloc: 'opp' },
  'ני':  { id: 'noam',       ko: '노암',                 en: 'Noam',                    leader: '마오즈',     bloc: 'opp' },
};
const AGREEMENTS = [['מחל', 'ט'], ['שס', 'ג'], ['דרך', 'אמת'], ['רק', 'ל'], ['ודם', 'עם']];

// ---------------------------------------------------------------------
export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));
    const url = new URL(request.url);
    const source = (env.SOURCE || 'relay').toLowerCase();

    try {
      switch (url.pathname.replace(/\/+$/, '') || '/') {
        case '/':
        case '/api':
          return json({
            name: '이스라엘 제26대 크네세트 총선 개표 API', source,
            endpoints: ['/api/results', '/api/localities?sort=voters&limit=50', '/api/locality?code=5000',
                        '/api/locality?name=תל אביב', '/api/parties', '/api/polls', '/files/expc.csv'],
          });

        case '/api/parties':
          return json({ threshold: THRESHOLD, seats: SEATS,
            parties: Object.entries(PARTIES).map(([letter, p]) => ({ letter, ...p })), agreements: AGREEMENTS });

        case '/api/results':
          return json(summary(await load(source, ctx)));

        case '/api/localities': {
          const d = await load(source, ctx);
          const list = d.locs.map(l => locOut(l, d.codes));
          if (url.searchParams.get('sort') === 'name') list.sort((a, b) => a.ishuv.localeCompare(b.ishuv, 'he'));
          else list.sort((a, b) => b.voters - a.voters);
          const limit = +url.searchParams.get('limit') || list.length;
          return json({ status: d.status, updated: d.updated, count: list.length, localities: list.slice(0, limit) });
        }

        case '/api/locality': {
          const d = await load(source, ctx);
          const code = url.searchParams.get('code'), name = url.searchParams.get('name');
          const hit = d.locs.find(l => (code && String(l.code) === code) || (name && l.name.trim() === name.trim()));
          if (!hit) return json({ error: '해당 지역이 없거나 아직 개표되지 않았습니다', code, name }, 404);
          return json({ status: d.status, updated: d.updated, ...locOut(hit, d.codes) });
        }

        case '/api/polls': {
          const r = await cachedFetch(POLLS_URL, ctx, 1800);
          return cors(new Response(r.body, { status: r.status,
            headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=1800' } }));
        }

        default:
          if (url.pathname.startsWith('/files/')) {           // 선관위 원본 파일 중계
            const r = await cachedFetch(CEC_HOST + url.pathname, ctx, CACHE_SECONDS);
            return cors(new Response(r.body, r));
          }
          return json({ error: '없는 경로입니다. /api 를 확인하세요.' }, 404);
      }
    } catch (e) {
      return json({ error: e.message }, 502);
    }
  },
};

// ---------------------------------------------------------------------
//  데이터 불러오기 → 공통 형식
//  { status, updated, codes[], national{r,t,x,v[]}, locs[{code,name,r,t,x,boxes,v[]}] }
//  r=유권자(בזב) t=투표자(מצביעים) x=무효(פסולים) v=정당별 득표(codes 순서)
// ---------------------------------------------------------------------
async function load(source, ctx) {
  if (source === 'cec') {
    const r = await cachedFetch(CEC_HOST + '/files/expc.csv', ctx, CACHE_SECONDS);
    if (!r.ok) throw new Error('선관위 CSV를 받지 못했습니다 (HTTP ' + r.status + ')');
    return fromCSV(decode(await r.arrayBuffer()));
  }
  const r = await cachedFetch(RELAY_URL, ctx, CACHE_SECONDS);
  if (!r.ok) throw new Error('중계 데이터를 받지 못했습니다 (HTTP ' + r.status + ')');
  const j = await r.json();
  return {
    status: j.status === 'counting' ? (j.test_env ? 'test' : 'counting') : 'pre',
    updated: j.fetched_at, cecTime: j.cec_time, codes: j.codes || [],
    national: j.national && j.national.v ? j.national : { r: 0, t: 0, x: 0, v: [] },
    locs: (j.locs || []).map(([code, name, r, t, x, boxes, v]) => ({ code, name, r, t, x, boxes, v })),
  };
}

function fromCSV(text) {
  const rows = parseCSV(text.replace(/^﻿/, ''));
  const head = rows[0].map(h => h.trim());
  const META = new Set(['סמל ועדה', 'שם ישוב', 'סמל ישוב', 'בזב', 'מצביעים', 'פסולים', 'כשרים', 'ברזל', 'קלפי', 'ריכוז', 'שופט', '']);
  const pcols = head.map((h, i) => [h, i]).filter(([h]) => !META.has(h));
  const ix = n => head.indexOf(n);
  const codes = pcols.map(([h]) => h);
  const locs = [], nat = { r: 0, t: 0, x: 0, v: codes.map(() => 0) };
  for (const r of rows.slice(1)) {
    const code = parseInt(r[ix('סמל ישוב')], 10); if (!Number.isFinite(code)) continue;   // 합계 행 등 제외
    const v = pcols.map(([, i]) => num(r[i]));
    const l = { code, name: (r[ix('שם ישוב')] || '').trim(), r: num(r[ix('בזב')]), t: num(r[ix('מצביעים')]), x: num(r[ix('פסולים')]), boxes: null, v };
    if (!l.t && !v.some(Boolean)) continue;
    locs.push(l); nat.r += l.r; nat.t += l.t; nat.x += l.x; v.forEach((n, k) => nat.v[k] += n);
  }
  return { status: locs.length ? 'counting' : 'pre', updated: new Date().toISOString(), codes, national: nat, locs };
}

// ---------------------------------------------------------------------
//  출력 형식
// ---------------------------------------------------------------------
function summary(d) {
  const n = d.national, valid = n.v.reduce((a, b) => a + b, 0);
  const votes = {};
  d.codes.forEach((c, i) => { votes[c] = (votes[c] || 0) + (n.v[i] || 0); });
  for (const letter of Object.keys(PARTIES)) votes[letter] ??= 0;
  const seats = valid ? allocate(votes, valid) : {};
  const parties = Object.entries(votes).map(([letter, v]) => {
    const p = PARTIES[letter];
    return {
      letter, id: p?.id || null, name: p?.ko || (letter === 'OTHER' ? '군소정당 합계' : letter), name_en: p?.en || null,
      leader: p?.leader || null, bloc: p?.bloc || 'other', votes: v,
      share: valid ? +(v / valid * 100).toFixed(2) : 0,
      passed: letter !== 'OTHER' && valid > 0 && v >= valid * THRESHOLD, seats: seats[letter] || 0,
    };
  }).sort((a, b) => b.seats - a.seats || b.votes - a.votes);
  const blocs = { gov: 0, opp: 0, other: 0 };
  parties.forEach(p => { blocs[p.bloc] += p.seats; });
  return {
    api: 'israel-election-live', status: d.status, updated: d.updated, cec_time: d.cecTime || null,
    counted_pct: +Math.min(100, n.r / ELIGIBLE_TOTAL * 100).toFixed(2),
    eligible_counted: n.r, voters: n.t, invalid: n.x, valid,
    turnout_pct: n.r ? +(n.t / n.r * 100).toFixed(2) : null,
    threshold_votes: Math.ceil(valid * THRESHOLD),
    blocs, majority: blocs.gov >= 61 ? 'gov' : blocs.opp >= 61 ? 'opp' : null,
    parties,
    note: '의석은 봉쇄조항 3.25%와 잔여표 합의를 반영한 바데르-오페르(동트) 방식 추정치입니다.',
  };
}

function locOut(l, codes) {
  const valid = l.v.reduce((a, b) => a + b, 0);
  const votes = {};
  codes.forEach((c, i) => { if (l.v[i]) votes[c] = (votes[c] || 0) + l.v[i]; });
  const top = Object.entries(votes).sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([letter, v]) => ({ letter, name: PARTIES[letter]?.ko || (letter === 'OTHER' ? '군소정당 합계' : letter), votes: v, share: valid ? +(v / valid * 100).toFixed(2) : 0 }));
  return {
    code: l.code, ishuv: l.name, eligible: l.r, voters: l.t, invalid: l.x, valid, kalfi_counted: l.boxes,
    turnout_pct: l.r ? +(l.t / l.r * 100).toFixed(2) : null, top, votes,
  };
}

// ---------------------------------------------------------------------
//  의석 계산: 봉쇄조항 → 잔여표 합의 쌍을 한 단위로 동트 배분 → 쌍 안에서 다시 동트
// ---------------------------------------------------------------------
function dhondt(units, n) {
  const s = units.map(() => 0);
  for (let k = 0; k < n; k++) {
    let best = -1, bi = -1;
    units.forEach((u, i) => { const q = u.votes / (s[i] + 1); if (q > best) { best = q; bi = i; } });
    if (bi < 0) break; s[bi]++;
  }
  return s;
}
function allocate(votes, valid) {
  const passed = Object.entries(votes).filter(([l, v]) => l !== 'OTHER' && v >= valid * THRESHOLD).map(([letter, v]) => ({ letter, votes: v }));
  const by = Object.fromEntries(passed.map(p => [p.letter, p]));
  const used = new Set(), units = [];
  for (const [a, b] of AGREEMENTS) if (by[a] && by[b]) { units.push({ m: [by[a], by[b]], votes: by[a].votes + by[b].votes }); used.add(a); used.add(b); }
  passed.forEach(p => { if (!used.has(p.letter)) units.push({ m: [p], votes: p.votes }); });
  const out = {};
  dhondt(units, SEATS).forEach((s, i) => {
    const u = units[i];
    if (u.m.length === 1) out[u.m[0].letter] = s;
    else dhondt(u.m, s).forEach((t, j) => { out[u.m[j].letter] = t; });
  });
  return out;
}

// ---------------------------------------------------------------------
//  도우미
// ---------------------------------------------------------------------
async function cachedFetch(target, ctx, ttl) {
  const cache = caches.default, key = new Request(target);
  let res = await cache.match(key);
  if (res) return res;
  const up = await fetch(target, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': '*/*' } });
  res = new Response(up.body, up);
  res.headers.set('Cache-Control', `public, max-age=${ttl}`);
  if (up.ok) ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}
function decode(buf) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch { return new TextDecoder('windows-1255').decode(buf); }
}
function parseCSV(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim()));
}
const num = v => parseInt(String(v ?? '').replace(/[^\d-]/g, ''), 10) || 0;
function json(obj, status = 200) {
  return cors(new Response(JSON.stringify(obj, null, 2), { status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': `public, max-age=${CACHE_SECONDS}` } }));
}
function cors(res) {
  const r = new Response(res.body, res);
  r.headers.set('Access-Control-Allow-Origin', '*');
  r.headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  return r;
}

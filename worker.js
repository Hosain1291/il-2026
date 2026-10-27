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
//    /api/stream           실시간 스트림(SSE) — 결과가 바뀔 때마다 자동 전송, 15초 간격 확인
//    /files/expc.csv       선관위 원본 CSV 중계
//
//  브라우저 주소창에서 /api/... 를 열면 30초마다 자동 갱신되는 뷰어가 뜸 (새로고침 불필요)
//  JSON 원문이 필요하면 ?format=json 을 붙이거나 fetch()로 호출
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

// 투표용지 기호 → 정당 정보 (bloc: gov 여당 / opp 야당 / mid 아랍·제3지대·무소속 (group: arab / third / unaligned))
const PARTIES = {
  'מחל': { id: 'likud',      ko: '리쿠드당',               en: 'Likud',                   leader: '네타냐후',   bloc: 'gov' },
  'ב':   { id: 'otzma',      ko: '유대의 힘',       en: 'Otzma Yehudit',           leader: '벤그비르',   bloc: 'gov' },
  'ט':   { id: 'rzp',        ko: '종교시오니즘당', en: 'Religious Zionism–Zehut', leader: '스모트리치', bloc: 'gov' },
  'שס':  { id: 'shas',       ko: '샤스',                 en: 'Shas',                    leader: '데리',       bloc: 'gov' },
  'ג':   { id: 'utj',        ko: '토라유대주의연합',        en: 'United Torah Judaism',    leader: '골드크노프', bloc: 'gov' },
  'רק':  { id: 'together',   ko: '비야하드',             en: 'Together',                leader: '베네트',     bloc: 'opp' },
  'דרך': { id: 'yashar',     ko: '야샤르당',               en: 'Yashar',                  leader: '아이젠코트', bloc: 'opp' },
  'כן':  { id: 'bluewhite',  ko: '청백당',               en: 'Blue and White',          leader: '간츠',       bloc: 'opp' },
  'אמת': { id: 'democrats',  ko: '민주당',               en: 'The Democrats',           leader: '골란',       bloc: 'opp' },
  'ל':   { id: 'yb',         ko: '이스라엘 베이테누',     en: 'Yisrael Beiteinu',        leader: '리베르만',   bloc: 'opp' },
  'די':  { id: 'reservists', ko: '예비군당',         en: 'The Reservists',          leader: '헨델',       bloc: 'mid', group: 'third' },
  'ך':   { id: 'amcha',      ko: '이스라엘 인민당',         en: 'Amcha Yisrael',           leader: '윈터',       bloc: 'opp' },
  'ודם': { id: 'joint',      ko: '공동명부',             en: 'Joint List',              leader: '자바린',     bloc: 'mid', group: 'arab' },
  'עם':  { id: 'raam',       ko: '라암',                 en: "Ra'am",                   leader: '압바스',     bloc: 'opp' },
  'ני':  { id: 'noam',       ko: '노암',                 en: 'Noam',                    leader: '마오즈',     bloc: 'mid', group: 'unaligned' },
};
const AGREEMENTS = [['מחל', 'ט'], ['שס', 'ג'], ['דרך', 'אמת'], ['רק', 'ל'], ['ודם', 'עם']];

// ---------------------------------------------------------------------
export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));
    const url = new URL(request.url);
    const source = (env.SOURCE || 'relay').toLowerCase();

    // 브라우저 주소창으로 /api/... 를 열면 → 자동 갱신 뷰어 페이지
    // (fetch 코드나 ?format=json 으로 부르면 → 그대로 JSON)
    const wantsHTML = (request.headers.get('Accept') || '').includes('text/html');
    if (wantsHTML && url.pathname.startsWith('/api') && url.searchParams.get('format') !== 'json') {
      return new Response(viewerHTML(), { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
    }

    // 실시간 스트림(Server-Sent Events): 새로고침 없이 결과가 바뀔 때마다 밀어줌
    if (url.pathname === '/api/stream') return stream(source, ctx);

    try {
      switch (url.pathname.replace(/\/+$/, '') || '/') {
        case '/':
        case '/api':
          return json({
            name: '이스라엘 제26대 크네세트 총선 개표 API', source,
            endpoints: ['/api/results', '/api/stream', '/api/localities?sort=voters&limit=50', '/api/locality?code=5000',
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
      leader: p?.leader || null, bloc: p?.bloc || 'other', group: p?.group || null, votes: v,
      share: valid ? +(v / valid * 100).toFixed(2) : 0,
      passed: letter !== 'OTHER' && valid > 0 && v >= valid * THRESHOLD, seats: seats[letter] || 0,
    };
  }).sort((a, b) => b.seats - a.seats || b.votes - a.votes);
  const blocs = { gov: 0, opp: 0, mid: 0, other: 0 };
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
//  실시간 스트림 (SSE): 15초마다 확인해서 바뀌었으면 'results' 이벤트 전송, 최대 10분 유지 후 브라우저가 자동 재연결
// ---------------------------------------------------------------------
function stream(source, ctx) {
  const { readable, writable } = new TransformStream();
  const w = writable.getWriter(), enc = new TextEncoder();
  const send = (event, data) => w.write(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  ctx.waitUntil((async () => {
    let last = '';
    try {
      await w.write(enc.encode('retry: 5000\n\n'));
      for (let i = 0; i < 40; i++) {                       // 15초 × 40 = 10분
        try {
          const sum = summary(await load(source, ctx));
          const key = JSON.stringify([sum.status, sum.valid, sum.counted_pct]);
          if (key !== last) { await send('results', sum); last = key; }
          else await w.write(enc.encode(`: 변화 없음 ${new Date().toISOString()}\n\n`));
        } catch (e) { await send('error', { error: e.message }); }
        await new Promise(r => setTimeout(r, 15000));
      }
    } catch { /* 브라우저가 연결을 끊음 */ }
    try { await w.close(); } catch {}
  })());
  return cors(new Response(readable, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'Connection': 'keep-alive' } }));
}

// ---------------------------------------------------------------------
//  자동 갱신 뷰어 (브라우저로 /api/... 를 열었을 때)
// ---------------------------------------------------------------------
function viewerHTML() {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>개표 API 실시간 보기</title>
<style>
:root{color-scheme:dark}
body{margin:0;background:#07101f;color:#e8eef8;font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
header{position:sticky;top:0;display:flex;flex-wrap:wrap;gap:10px 16px;align-items:center;padding:12px 16px;background:#0d1d3a;border-bottom:1px solid #1f3560}
header b{font:700 16px system-ui,sans-serif}
.dot{width:10px;height:10px;border-radius:50%;background:#3a4660;display:inline-block;margin-right:6px}
.dot.on{background:#e3262f;animation:b 1.2s infinite}@keyframes b{50%{opacity:.2}}
.dot.err{background:#c99700}
select,button{background:#132647;color:#e8eef8;border:1px solid #2a4577;border-radius:6px;padding:5px 9px;font:13px system-ui,sans-serif}
#meta{color:#8fa0bd;font:13px system-ui,sans-serif;margin-left:auto}
pre{margin:0;padding:16px;white-space:pre-wrap;word-break:break-word}
.k{color:#8fb6ff}.s{color:#a5e3a1}.n{color:#ffc83d}.b{color:#f08f8f}
.chg{background:rgba(255,200,61,.25);border-radius:3px;transition:background 3s}
</style></head><body>
<header><span><span class="dot" id="dot"></span><b>개표 API 실시간 보기</b></span>
<select id="sel"></select>
<span id="meta">불러오는 중</span></header>
<pre id="out"></pre>
<script>
const EP=['/api/results','/api/localities?limit=30','/api/parties','/api/polls','/api'];
const sel=document.getElementById('sel'), out=document.getElementById('out'), meta=document.getElementById('meta'), dot=document.getElementById('dot');
const cur=location.pathname+location.search;
[...new Set([cur,...EP])].forEach(p=>sel.add(new Option(p,p,false,p===cur)));
sel.onchange=()=>{ history.replaceState(null,'',sel.value); prev=null; load(); };
let prev=null, timer, left=0, es=null; const SEC=20;
const esc=s=>s.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
function paint(obj){
  const now={}, pad=n=>'  '.repeat(n);
  function val(v,path){
    now[path]=v; const hit=prev&&prev[path]!==undefined&&prev[path]!==v;
    const cls=typeof v==='string'?'s':typeof v==='number'?'n':'b';
    return '<span class="'+cls+(hit?' chg':'')+'">'+esc(JSON.stringify(v))+'</span>';
  }
  function walk(o,path,d){
    if(o===null||typeof o!=='object') return val(o,path);
    const arr=Array.isArray(o), ks=Object.keys(o);
    if(!ks.length) return arr?'[]':'{}';
    const items=ks.map(k=>pad(d+1)+(arr?'':'<span class="k">'+esc(JSON.stringify(k))+'</span>: ')+walk(o[k],path+'.'+k,d+1));
    return (arr?'[':'{')+'\\n'+items.join(',\\n')+'\\n'+pad(d)+(arr?']':'}');
  }
  out.innerHTML=walk(obj,'',0); prev=now;
}
async function load(){
  try{
    const u=new URL(sel.value,location.origin); u.searchParams.set('format','json'); u.searchParams.set('t',Date.now());
    const r=await fetch(u,{cache:'no-store'}); const j=await r.json(); paint(j);
    dot.className='dot '+(j.status==='counting'?'on':''); meta.dataset.t=new Date().toLocaleTimeString('ko-KR');
  }catch(e){ dot.className='dot err'; meta.dataset.t='오류: '+e.message; }
  left=SEC; tick();
}
function tick(){ meta.textContent=(meta.dataset.t||'')+' 기준 · '+left+'초 뒤 자동 갱신'; }
setInterval(()=>{ left--; if(left<=0) load(); else tick(); },1000);
document.addEventListener('visibilitychange',()=>{ if(!document.hidden) load(); });
load();
<\/script></body></html>`;
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

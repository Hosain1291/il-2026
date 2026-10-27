#!/usr/bin/env python3
"""개표 데이터를 받아 api/*.json 파일로 만든다.

출처 (앞에서부터 차례로 시도)
  1) 중앙선관위 공식 결과 — https://votes26.bechirot.gov.il/  (클라우드에서 막히면 건너뜀)
  2) navonyaniv/election-il-2026 의 results.json (선관위 결과를 실시간으로 옮겨 GitHub Pages로 공개)
     결과 파일: https://media26.bechirot.gov.il/files/expc.csv (지역별)
     ※ 선관위는 GitHub 같은 클라우드 서버 접속을 막으므로, 집 컴퓨터에서 relay.py 로 돌릴 때 쓰임
  3) johnnoto/israel-election-watcher 의 live.json (선관위 파일을 90초마다 중계하는 비공식 데이터)

결과: api/results.json · api/localities.json · api/parties.json · api/status.json
사용: python scripts/build_api.py            # 1 → 2 순서
      python scripts/build_api.py --cec      # 선관위만 (relay.py 가 사용)
변경이 있으면 CHANGED, 없으면 UNCHANGED 를 출력.
"""
import csv, io, json, math, os, re, sys, time, urllib.request
from datetime import datetime, timezone, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'api')
CEC_SITE = 'https://votes26.bechirot.gov.il/'
CEC_EXPC = 'https://media26.bechirot.gov.il/files/expc.csv'
NAVON = [
    'https://navonyaniv.github.io/election-il-2026/results.json',
    'https://raw.githubusercontent.com/navonyaniv/election-il-2026/main/results.json',
]
WATCHER = [
    'https://raw.githubusercontent.com/johnnoto/israel-election-watcher/main/data/live.json',
    'https://johnnoto.github.io/israel-election-watcher/data/live.json',
]
POLLS_CLOSE = datetime(2026, 10, 27, 20, 0, tzinfo=timezone.utc)   # 투표 종료 = 한국시간 28일 05:00
UA = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36',
      'Accept-Language': 'he,ko;q=0.8,en;q=0.6'}
META_COLS = {'סמל ועדה', 'ברזל', 'שם ישוב', 'סמל ישוב', 'קלפי', 'ריכוז', 'שופט', 'בזב', 'מצביעים', 'פסולים', 'כשרים',
             'חיצוניות', 'קלפי אחרת', ''}
SEATS, THRESHOLD, ELIGIBLE_TOTAL = 120, 0.0325, 7331981

PARTIES = {
    'מחל': ('likud', '리쿠드당', 'Likud', '네타냐후', 'gov'),
    'ב':   ('otzma', '유대의 힘', 'Otzma Yehudit', '벤그비르', 'gov'),
    'ט':   ('rzp', '종교시오니즘당', 'Religious Zionism–Zehut', '스모트리치·페이글린', 'gov'),
    'שס':  ('shas', '샤스', 'Shas', '데리', 'gov'),
    'ג':   ('utj', '토라유대주의연합', 'United Torah Judaism', '아셰르', 'gov'),
    'רק':  ('together', '비야하드', 'Together', '베네트·라피드', 'opp'),
    'דרך': ('yashar', '야샤르당', 'Yashar', '아이젠코트', 'opp'),
    'אמת': ('democrats', '민주당', 'The Democrats', '골란', 'opp'),
    'ל':   ('yb', '이스라엘 베이테누', 'Yisrael Beiteinu', '리베르만', 'opp'),
    'די':  ('reservists', '예비군당', 'The Reservists', '헨델·젤레카', 'mid'),
    'ך':   ('amcha', '이스라엘 인민당', 'Amcha Yisrael', '윈터', 'opp'),
    'ודם': ('joint', '공동명부', 'Joint List', '자바린·티비', 'mid'),
    'עם':  ('raam', '라암', "Ra'am", '압바스', 'mid'),
    'ני':  ('noam', '노암', 'Noam', '마오즈', 'mid'),
}
GROUP = {'joint': 'arab', 'raam': 'arab', 'reservists': 'third', 'noam': 'unaligned'}  # mid 진영 세부: 아랍 / 제3지대 / 무소속
AGREEMENTS = [('מחל', 'ט'), ('שס', 'ג'), ('דרך', 'אמת'), ('רק', 'ל'), ('ודם', 'עם')]


def get(url, timeout=40):
    req = urllib.request.Request(url + ('&' if '?' in url else '?') + f'_={int(time.time())}', headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def num(x):
    try:
        return int(float(str(x).replace(',', '').strip() or 0))
    except ValueError:
        return 0


def fetch_cec():
    """선관위 공식 사이트에서 직접 받아 live.json 과 같은 형태로 바꿈."""
    test_env, cec_time = False, None
    try:
        html = get(CEC_SITE).decode('utf-8', 'replace')
        test_env = 'סביבת בדיקות' in html
        m = re.search(r'תוצאות נכון ל-?\s*([0-9/.]+\s+[0-9:]+)', html)
        cec_time = m.group(1) if m else None
    except Exception as e:
        print('경고: 선관위 결과 페이지 접속 실패:', e, file=sys.stderr)
    raw = get(CEC_EXPC)
    try:
        text = raw.decode('utf-8-sig')
    except UnicodeDecodeError:
        text = raw.decode('cp1255')
    rows = list(csv.reader(io.StringIO(text)))
    head = [h.strip() for h in rows[0]]
    if 'סמל ישוב' not in head:
        raise RuntimeError('선관위 CSV 형식이 예상과 다름')
    codes = [h for h in head if h not in META_COLS]
    ix = {h: i for i, h in enumerate(head)}
    nat = {'r': 0, 't': 0, 'x': 0, 'v': [0] * len(codes)}
    locs = []
    for r in rows[1:]:
        d = dict(zip(head, r))
        try:
            code = int(str(d.get('סמל ישוב', '')).strip())
        except ValueError:
            continue                                   # 합계 행 등
        v = [num(r[ix[c]]) if ix[c] < len(r) else 0 for c in codes]
        lr, lt, lx = num(d.get('בזב')), num(d.get('מצביעים')), num(d.get('פסולים'))
        if lt == 0 and sum(v) == 0:
            continue                                   # 아직 개표 안 됨
        locs.append([code, d.get('שם ישוב', '').strip(), lr, lt, lx, None, v])
        nat['r'] += lr; nat['t'] += lt; nat['x'] += lx
        nat['v'] = [a + b for a, b in zip(nat['v'], v)]
    if datetime.now(timezone.utc) < POLLS_CLOSE:
        test_env = True                                # 투표 종료 전에 올라온 숫자는 시험 데이터
    return {'status': 'counting' if locs else 'pre', 'test_env': test_env, 'cec_time': cec_time,
            'fetched_at': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
            'codes': codes, 'national': nat, 'locs': locs}


def from_navon(j):
    """navonyaniv/election-il-2026 results.json → live.json 형태."""
    plist = [p if isinstance(p, str) else (p.get('letters') or p.get('letter') or '') for p in (j.get('parties') or [])]
    def vec_of(row):
        votes = {}
        for i, x in enumerate(row[4] if len(row) > 4 and isinstance(row[4], list) else []):
            if isinstance(x, list):
                votes[str(x[0]).strip()] = votes.get(str(x[0]).strip(), 0) + num(x[1])
            elif isinstance(x, dict):
                k = (x.get('letters') or x.get('letter') or '').strip(); votes[k] = votes.get(k, 0) + num(x.get('votes', 0))
            elif i < len(plist):
                votes[plist[i].strip()] = votes.get(plist[i].strip(), 0) + num(x)
        return votes
    c = j.get('country') or [0, 0, 0, 0, []]
    nv = vec_of(c)
    codes = list(nv)
    locs = []
    for code, row in (j.get('towns') or {}).items():
        tv = vec_of(row)
        if sum(tv.values()):
            locs.append([int(code), str(code), num(row[0]), num(row[1]), num(row[2]), None, [tv.get(k, 0) for k in codes]])
    counting = sum(nv.values()) > 0
    test = bool(j.get('rehearsal')) or datetime.now(timezone.utc) < POLLS_CLOSE
    return {'status': 'counting' if counting else 'pre', 'test_env': test, 'cec_time': j.get('updated_label'),
            'fetched_at': j.get('updated'), 'codes': codes,
            'national': {'r': num(c[0]), 't': num(c[1]), 'x': num(c[2]), 'v': [nv[k] for k in codes]}, 'locs': locs,
            'turnout': j.get('turnout')}


def fetch(cec_only=False):
    errs = []
    try:
        return fetch_cec(), 'cec:' + CEC_EXPC
    except Exception as e:
        errs.append(f'선관위: {e}')
        if cec_only:
            raise SystemExit('선관위 데이터를 받지 못함: ' + str(e))
    for url in NAVON:
        try:
            return from_navon(json.loads(get(url, 30))), url
        except Exception as e:
            errs.append(f'{url}: {e}')
    for url in WATCHER:
        try:
            return json.loads(get(url, 30)), url
        except Exception as e:
            errs.append(f'{url}: {e}')
    raise SystemExit('데이터를 받지 못함: ' + ' / '.join(errs))


def relay_is_fresh():
    """집 컴퓨터의 relay.py 가 최근 10분 안에 선관위 데이터를 올렸으면 GitHub Actions 는 덮어쓰지 않음."""
    try:
        st = json.load(open(os.path.join(OUT, 'status.json'), encoding='utf-8'))
        t = datetime.strptime(st['checked_at'], '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=timezone.utc)
        return st.get('source', '').startswith('cec:') and st.get('via') == 'relay' and datetime.now(timezone.utc) - t < timedelta(minutes=10)
    except Exception:
        return False


def dhondt(votes, n):
    s = [0] * len(votes)
    for _ in range(n):
        q = [v / (s[i] + 1) for i, v in enumerate(votes)]
        if not q or max(q) <= 0:
            break
        s[q.index(max(q))] += 1
    return s


def allocate(votes, valid):
    passed = {l: v for l, v in votes.items() if l != 'OTHER' and v >= valid * THRESHOLD}
    units, used = [], set()
    for a, b in AGREEMENTS:
        if a in passed and b in passed:
            units.append([a, b]); used |= {a, b}
    units += [[l] for l in passed if l not in used]
    out = {}
    for u, s in zip(units, dhondt([sum(passed[l] for l in u) for u in units], SEATS)):
        if len(u) == 1:
            out[u[0]] = s
        else:
            for l, t in zip(u, dhondt([passed[l] for l in u], s)):
                out[l] = t
    return out


WITHDRAWN = {'כן': '청백당(사퇴)', 'צבי': '아히(사퇴)', 'רץ': '하카할(사퇴)'}


def name(l):
    return PARTIES[l][1] if l in PARTIES else WITHDRAWN.get(l, '군소정당 합계' if l == 'OTHER' else l)


def main():
    cec_only = '--cec' in sys.argv
    via = 'relay' if cec_only else 'actions'
    if not cec_only and relay_is_fresh():
        print('UNCHANGED 집 컴퓨터 중계(relay.py)가 최신 데이터를 올리는 중'); return
    j, src = fetch(cec_only)
    status = 'pre' if j.get('status') != 'counting' else ('test' if j.get('test_env') else 'counting')
    codes = j.get('codes') or []
    nat = j.get('national') or {}
    v = nat.get('v') or [0] * len(codes)
    if status != 'counting':          # 시험 데이터·개표 전에는 숫자를 내보내지 않음
        v = [0] * len(codes); nat = {'r': 0, 't': 0, 'x': 0}
    votes = {}
    for c, n in zip(codes, v):
        votes[c] = votes.get(c, 0) + n
    for l in PARTIES:
        votes.setdefault(l, 0)
    valid = sum(votes.values())
    seats = allocate(votes, valid) if valid else {}
    parties = []
    for l, n in votes.items():
        p = PARTIES.get(l)
        parties.append({
            'letter': l, 'id': p[0] if p else None, 'name': name(l), 'name_en': p[2] if p else None,
            'leader': p[3] if p else None, 'bloc': p[4] if p else 'other', 'group': GROUP.get(p[0]) if p else None, 'votes': n,
            'share': round(n / valid * 100, 2) if valid else 0,
            'passed': l != 'OTHER' and valid > 0 and n >= valid * THRESHOLD, 'seats': seats.get(l, 0),
        })
    parties.sort(key=lambda p: (-p['seats'], -p['votes']))
    blocs = {'gov': 0, 'opp': 0, 'mid': 0, 'other': 0}
    for p in parties:
        blocs[p['bloc']] += p['seats']
    r = nat.get('r', 0)
    results = {
        'api': 'israel-election-live', 'status': status,
        'updated': j.get('fetched_at'), 'cec_time': j.get('cec_time'),
        'counted_pct': round(min(100, r / ELIGIBLE_TOTAL * 100), 2),
        'eligible_counted': r, 'voters': nat.get('t', 0), 'invalid': nat.get('x', 0), 'valid': valid,
        'turnout_pct': round(nat.get('t', 0) / r * 100, 2) if r else None,
        'threshold_votes': math.ceil(valid * THRESHOLD),
        'blocs': blocs, 'majority': 'gov' if blocs['gov'] >= 61 else 'opp' if blocs['opp'] >= 61 else None,
        'parties': parties,
        'note': '의석은 봉쇄조항 3.25%와 잔여표 합의를 반영한 바데르-오페르(동트) 방식 추정치입니다.',
    }
    locs = []
    if status == 'counting':
        for code, nm, lr, lt, lx, boxes, lv in j.get('locs') or []:
            lvotes = {}
            for c, n in zip(codes, lv):
                if n:
                    lvotes[c] = lvotes.get(c, 0) + n
            lvalid = sum(lvotes.values())
            top = sorted(lvotes.items(), key=lambda kv: -kv[1])[:5]
            locs.append({'code': code, 'ishuv': nm, 'eligible': lr, 'voters': lt, 'invalid': lx, 'valid': lvalid,
                         'kalfi_counted': boxes, 'turnout_pct': round(lt / lr * 100, 2) if lr else None,
                         'top': [{'letter': l, 'name': name(l), 'votes': n, 'share': round(n / lvalid * 100, 2) if lvalid else 0} for l, n in top],
                         'votes': lvotes})
        locs.sort(key=lambda x: -x['voters'])

    files = {
        'results.json': results,
        'localities.json': {'status': status, 'updated': j.get('fetched_at'), 'count': len(locs), 'localities': locs},
        'parties.json': {'threshold': THRESHOLD, 'seats': SEATS, 'agreements': AGREEMENTS,
                         'blocs': {'gov': '여당', 'opp': '야당', 'mid': '아랍·제3지대·무소속'},
                         'parties': [{'letter': l, 'id': p[0], 'name': p[1], 'name_en': p[2], 'leader': p[3], 'bloc': p[4], 'group': GROUP.get(p[0])} for l, p in PARTIES.items()]},
    }
    os.makedirs(OUT, exist_ok=True)
    changed = False
    for fn, data in files.items():
        path = os.path.join(OUT, fn)
        text = json.dumps(data, ensure_ascii=False, indent=2)
        old = open(path, encoding='utf-8').read() if os.path.exists(path) else None
        if old != text:
            open(path, 'w', encoding='utf-8').write(text); changed = True
    status_doc = {'checked_at': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'), 'source': src,
                  'status': status, 'data_updated': j.get('fetched_at'), 'cec_time': j.get('cec_time'), 'via': via, 'turnout': j.get('turnout')}
    if changed or via == 'relay' or not os.path.exists(os.path.join(OUT, 'status.json')):
        json.dump(status_doc, open(os.path.join(OUT, 'status.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
    print(('CHANGED' if changed else 'UNCHANGED') + f' status={status} valid={valid} localities={len(locs)}')
    return changed


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""개표 데이터를 받아 api/*.json 파일로 만든다 (GitHub Actions에서 실행).

출처: johnnoto/israel-election-watcher 의 live.json
      (선관위가 GitHub 등 클라우드 서버를 막아서, 개인 맥에서 받아 중계하는 비공식 데이터)
결과: api/results.json · api/localities.json · api/parties.json · api/status.json
변경이 있으면 CHANGED, 없으면 UNCHANGED 를 출력.
"""
import json, math, os, sys, urllib.request
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'api')
SOURCES = [
    'https://raw.githubusercontent.com/johnnoto/israel-election-watcher/main/data/live.json',
    'https://johnnoto.github.io/israel-election-watcher/data/live.json',
]
SEATS, THRESHOLD, ELIGIBLE_TOTAL = 120, 0.0325, 7331981

PARTIES = {
    'מחל': ('likud', '리쿠드당', 'Likud', '네타냐후', 'gov'),
    'ב':   ('otzma', '유대의 힘', 'Otzma Yehudit', '벤그비르', 'gov'),
    'ט':   ('rzp', '종교시오니즘당', 'Religious Zionism–Zehut', '스모트리치', 'gov'),
    'שס':  ('shas', '샤스', 'Shas', '데리', 'gov'),
    'ג':   ('utj', '토라유대주의연합', 'United Torah Judaism', '골드크노프', 'gov'),
    'רק':  ('together', '비야하드', 'Together', '베네트', 'opp'),
    'דרך': ('yashar', '야샤르당', 'Yashar', '아이젠코트', 'opp'),
    'כן':  ('bluewhite', '청백당', 'Blue and White', '간츠', 'opp'),
    'אמת': ('democrats', '민주당', 'The Democrats', '골란', 'opp'),
    'ל':   ('yb', '이스라엘 베이테누', 'Yisrael Beiteinu', '리베르만', 'opp'),
    'די':  ('reservists', '예비군당', 'The Reservists', '헨델', 'opp'),
    'ך':   ('amcha', '이스라엘 인민당', 'Amcha Yisrael', '윈터', 'opp'),
    'ודם': ('joint', '공동명부', 'Joint List', '자바린', 'opp'),
    'עם':  ('raam', '라암', "Ra'am", '압바스', 'opp'),
    'ני':  ('noam', '노암', 'Noam', '마오즈', 'opp'),
}
AGREEMENTS = [('מחל', 'ט'), ('שס', 'ג'), ('דרך', 'אמת'), ('רק', 'ל'), ('ודם', 'עם')]


def fetch():
    last = None
    for url in SOURCES:
        try:
            req = urllib.request.Request(url + f'?t={int(datetime.now().timestamp())}', headers={'User-Agent': 'il-2026-api'})
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r), url
        except Exception as e:
            last = e
    raise SystemExit(f'데이터를 받지 못함: {last}')


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


def name(l):
    return PARTIES[l][1] if l in PARTIES else ('군소정당 합계' if l == 'OTHER' else l)


def main():
    j, src = fetch()
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
            'leader': p[3] if p else None, 'bloc': p[4] if p else 'other', 'votes': n,
            'share': round(n / valid * 100, 2) if valid else 0,
            'passed': l != 'OTHER' and valid > 0 and n >= valid * THRESHOLD, 'seats': seats.get(l, 0),
        })
    parties.sort(key=lambda p: (-p['seats'], -p['votes']))
    blocs = {'gov': 0, 'opp': 0, 'other': 0}
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
                         'parties': [{'letter': l, 'id': p[0], 'name': p[1], 'name_en': p[2], 'leader': p[3], 'bloc': p[4]} for l, p in PARTIES.items()]},
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
                  'status': status, 'data_updated': j.get('fetched_at')}
    if changed or not os.path.exists(os.path.join(OUT, 'status.json')):
        json.dump(status_doc, open(os.path.join(OUT, 'status.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
    print(('CHANGED' if changed else 'UNCHANGED') + f' status={status} valid={valid} localities={len(locs)}')


if __name__ == '__main__':
    main()

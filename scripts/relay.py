#!/usr/bin/env python3
"""선관위 → 내 깃허브 실시간 중계 (집 컴퓨터에서 실행)

중앙선관위(votes26.bechirot.gov.il)는 GitHub 같은 클라우드 서버의 접속을 막기 때문에,
집 컴퓨터가 1분마다 선관위 결과 파일을 직접 받아 api/*.json 으로 만들고
GitHub(Hosain1291/il-2026)에 바로 올린다. 개표 페이지와 API는 이 파일을 읽는다.

준비: 파이썬 3 만 있으면 됨 (추가 설치 없음)
      깃허브 토큰 1개 — https://github.com/settings/personal-access-tokens/new
        · Repository access: Only select repositories → il-2026
        · Permissions → Contents: Read and write
실행: 윈도우는 '중계시작.bat' 더블클릭, 맥/리눅스는  python3 scripts/relay.py
      한 번만 확인:  python3 scripts/relay.py --once
멈춤: 창을 닫거나 Ctrl+C
"""
import base64, json, os, sys, time, urllib.request, urllib.error
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_api  # noqa: E402

REPO = 'Hosain1291/il-2026'
BRANCH = 'main'
INTERVAL = 60                   # 초
HEARTBEAT = 5 * 60              # 데이터가 그대로여도 5분마다 '중계 중' 표시 갱신
TOKEN_FILE = os.path.join(os.path.expanduser('~'), '.il2026-token')
FILES = ['results.json', 'localities.json', 'parties.json', 'status.json']


def say(*a):
    print(datetime.now().strftime('%H:%M:%S'), *a, flush=True)


def token():
    t = os.environ.get('GITHUB_TOKEN', '').strip()
    if not t and os.path.exists(TOKEN_FILE):
        t = open(TOKEN_FILE, encoding='utf-8').read().strip()
    if not t:
        print('\n깃허브 토큰을 붙여 넣고 Enter (github_pat_ 로 시작). 이 컴퓨터에만 저장됩니다.')
        t = input('> ').strip()
        with open(TOKEN_FILE, 'w', encoding='utf-8') as f:
            f.write(t)
        try:
            os.chmod(TOKEN_FILE, 0o600)
        except OSError:
            pass
    return t


def gh(method, path, tok, body=None):
    req = urllib.request.Request('https://api.github.com' + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={'Authorization': f'Bearer {tok}', 'Accept': 'application/vnd.github+json',
                                          'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'il-2026-relay'})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read() or b'{}')
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b'{}')


def upload(tok, names):
    """바뀐 api 파일을 커밋 1개로 올림 (Git Data API)."""
    s, ref = gh('GET', f'/repos/{REPO}/git/ref/heads/{BRANCH}', tok)
    if s != 200:
        raise RuntimeError(f'브랜치 조회 실패 HTTP {s}: {ref.get("message")}')
    head = ref['object']['sha']
    s, commit = gh('GET', f'/repos/{REPO}/git/commits/{head}', tok)
    tree = []
    for n in names:
        content = open(os.path.join(build_api.OUT, n), 'rb').read()
        s, blob = gh('POST', f'/repos/{REPO}/git/blobs', tok, {'content': base64.b64encode(content).decode(), 'encoding': 'base64'})
        if s != 201:
            raise RuntimeError(f'업로드 실패 HTTP {s}: {blob.get("message")}')
        tree.append({'path': f'api/{n}', 'mode': '100644', 'type': 'blob', 'sha': blob['sha']})
    s, t = gh('POST', f'/repos/{REPO}/git/trees', tok, {'base_tree': commit['tree']['sha'], 'tree': tree})
    s, c = gh('POST', f'/repos/{REPO}/git/commits', tok,
              {'message': f'선관위 개표 중계 {datetime.now().strftime("%H:%M:%S")}', 'tree': t['sha'], 'parents': [head]})
    s, r = gh('PATCH', f'/repos/{REPO}/git/refs/heads/{BRANCH}', tok, {'sha': c['sha']})
    if s != 200:
        raise RuntimeError(f'커밋 반영 실패 HTTP {s}: {r.get("message")}')


def snapshot():
    out = {}
    for n in FILES:
        p = os.path.join(build_api.OUT, n)
        out[n] = open(p, 'rb').read() if os.path.exists(p) else b''
    return out


def main():
    once = '--once' in sys.argv
    tok = token()
    s, repo = gh('GET', f'/repos/{REPO}', tok)
    if s != 200:
        print(f'깃허브가 토큰을 받지 않았습니다 (HTTP {s}). {TOKEN_FILE} 를 지우고 새 토큰으로 다시 실행하세요.')
        sys.exit(1)
    say(f'깃허브 연결됨: {REPO}')
    sys.argv = [sys.argv[0], '--cec']
    last_up = 0
    while True:
        try:
            before = snapshot()
            build_api.main()
            after = snapshot()
            data_changed = [n for n in FILES if n != 'status.json' and before[n] != after[n]]
            if data_changed or time.time() - last_up > HEARTBEAT:
                upload(tok, data_changed + ['status.json'])
                last_up = time.time()
                say('올림:', ', '.join(data_changed) if data_changed else '중계 상태만')
        except SystemExit as e:
            say('선관위 접속 실패:', e)
        except Exception as e:
            say('오류:', e)
        if once:
            break
        time.sleep(INTERVAL)


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        print('\n중계를 멈췄습니다.')

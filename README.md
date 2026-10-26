# 2026 이스라엘 총선 개표방송

제26대 크네세트 총선(2026년 10월 27일) 실시간 개표 현황을 TV 개표방송처럼 보여 주는 개인용 페이지입니다.

**보기:** https://hosain1291.github.io/il-2026/

## 화면
- PC는 16:9, 휴대폰 세로 화면은 세로 전용 배치. 장면 5개가 12초마다 자동 전환 (여야 의석 · 의석 배치도 · 정당별 의석 · 정당별 득표율 · 정당 현황)
- 아래 탭, 화면 양옆 클릭, 휴대폰은 좌우로 밀어서 장면 이동, ← → 키, F 키로 전체 화면
- 30초마다 새로고침 없이 자동 갱신

## 데이터
- 기본: [johnnoto/israel-election-watcher](https://github.com/johnnoto/israel-election-watcher)의 `live.json` (선관위 결과 파일을 90초마다 중계하는 비공식 데이터)
- 투표 종료(한국시간 28일 05:00) 전에는 "개표 시작 전"으로 표시
- `?src=주소` 로 다른 데이터 지정 가능 (`worker.js` API의 `/api/results`, 선관위 CSV `/files/expc.csv`)

## API (레포 안에서 자동 갱신)
GitHub Actions가 15분마다 시작해서, 투표 종료 후에는 1분 간격으로 개표 데이터를 받아 `api/` 폴더를 갱신합니다. Cloudflare 같은 별도 서버는 필요 없습니다.

| 주소 | 내용 |
|---|---|
| https://hosain1291.github.io/il-2026/api/ | **자동 갱신 뷰어** (30초마다, 바뀐 값은 노란색) |
| https://hosain1291.github.io/il-2026/api/results.json | 전국 집계·정당별 득표·예상 의석·여야 합계 |
| https://hosain1291.github.io/il-2026/api/localities.json | 지역별 결과 |
| https://hosain1291.github.io/il-2026/api/parties.json | 정당 목록·잔여표 합의 |
| https://hosain1291.github.io/il-2026/api/status.json | 마지막 확인 시각·데이터 출처 |

개표 전이거나 선관위 시험 데이터일 때는 숫자를 0으로 둡니다.

## 의석 계산
봉쇄조항 3.25%와 잔여표 합의 5쌍을 반영한 바데르-오페르(동트) 방식 추정치입니다. 공식 결과와 다를 수 있습니다.

## worker.js (선택 · Cloudflare용, 안 써도 됨)
Cloudflare Workers에 올리면 개표 API가 됩니다: `/api/results`, `/api/localities`, `/api/locality?code=`, `/api/parties`, `/api/polls`, `/api/stream`

- 브라우저 주소창으로 `/api/...`를 열면 **30초마다 자동 갱신되는 뷰어**가 뜹니다. 바뀐 값은 노란색으로 표시됩니다.
- JSON 원문이 필요하면 `?format=json`을 붙이거나 `fetch()`로 부르세요.
- `/api/stream`은 결과가 바뀔 때마다 밀어주는 실시간 스트림(SSE)입니다:
  ```js
  const es = new EventSource('https://워커주소/api/stream');
  es.addEventListener('results', e => console.log(JSON.parse(e.data)));
  ```

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

## 의석 계산
봉쇄조항 3.25%와 잔여표 합의 5쌍을 반영한 바데르-오페르(동트) 방식 추정치입니다. 공식 결과와 다를 수 있습니다.

## worker.js (선택)
Cloudflare Workers에 올리면 개표 API가 됩니다: `/api/results`, `/api/localities`, `/api/locality?code=`, `/api/parties`, `/api/polls`, `/api/stream`

- 브라우저 주소창으로 `/api/...`를 열면 **30초마다 자동 갱신되는 뷰어**가 뜹니다. 바뀐 값은 노란색으로 표시됩니다.
- JSON 원문이 필요하면 `?format=json`을 붙이거나 `fetch()`로 부르세요.
- `/api/stream`은 결과가 바뀔 때마다 밀어주는 실시간 스트림(SSE)입니다:
  ```js
  const es = new EventSource('https://워커주소/api/stream');
  es.addEventListener('results', e => console.log(JSON.parse(e.data)));
  ```

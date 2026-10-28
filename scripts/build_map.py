#!/usr/bin/env python3
"""geoBoundaries 행정구역 경계(ADM1 6개 도, ADM2 15개 군)를 SVG 경로로 바꾸고,
각 지역(마을·도시 코드)이 어느 군·도에 속하는지 미리 계산해 map.json 으로 저장.

사용: python scripts/build_map.py ADM1.geojson ADM2.geojson towns.json
  towns.json: navonyaniv/election-il-2026 의 data/towns.json (지역 코드·중심 좌표, data.gov.il·OSM)
"""
import json, math, sys, os

ADM1_KO = {'Southern District': '남부', 'Central District': '중부', 'Jerusalem District': '예루살렘',
           'Tel Aviv': '텔아비브', 'Haifa': '하이파', 'Northern District': '북부'}
ADM2_KO = {"Be'er Sheva": '베르셰바', 'Jerusalem': '예루살렘', 'Ashqelon': '아슈켈론', 'Tel Aviv': '텔아비브',
           'Zefat': '츠팟', 'Rehovot': '레호보트', 'Ramla': '람라', 'Petah Tiqwa': '페타티크바', 'HaSharon': '하샤론',
           'Haifa': '하이파', 'Hadera': '하데라', 'Akko': '아코', "Yizre'el": '이즈르엘', 'Golan': '골란', 'Kinneret': '키네렛'}

LON0, LAT0, LAT_MID = 34.20, 33.40, 31.5
K = 400                                   # 경도 1도 ≈ 400*cos(lat) 단위
CX = math.cos(math.radians(LAT_MID))
def proj(lon, lat): return ((lon - LON0) * K * CX, (LAT0 - lat) * K)

def rings(geom):
    if geom['type'] == 'Polygon': return [geom['coordinates']]
    return geom['coordinates']

def path(geom):
    out = []
    for poly in rings(geom):
        for ring in poly:
            pts, last = [], None
            for lon, lat in ring:
                x, y = proj(lon, lat); p = (round(x, 1), round(y, 1))
                if p != last: pts.append(p); last = p
            if len(pts) > 2: out.append('M' + 'L'.join(f'{x:g},{y:g}' for x, y in pts) + 'Z')
    return ''.join(out)

def inside(lon, lat, geom):
    for poly in rings(geom):
        ring = poly[0]; c = False; j = len(ring) - 1
        for i in range(len(ring)):
            xi, yi = ring[i]; xj, yj = ring[j]
            if (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / (yj - yi) + xi: c = not c
            j = i
        if c: return True
    return False

def nearest(lon, lat, feats):
    best, bi = 1e9, None
    for i, f in enumerate(feats):
        for poly in rings(f['geometry']):
            for x, y in poly[0][::3]:
                d = (x - lon) ** 2 + (y - lat) ** 2
                if d < best: best, bi = d, i
    return bi, best

def main(a1, a2, towns_path):
    A1 = json.load(open(a1))['features']; A2 = json.load(open(a2))['features']
    towns = json.load(open(towns_path))
    adm1 = [{'n': ADM1_KO.get(f['properties']['shapeName'], f['properties']['shapeName']), 'd': path(f['geometry'])} for f in A1]
    adm2 = [{'n': ADM2_KO.get(f['properties']['shapeName'], f['properties']['shapeName']), 'd': path(f['geometry'])} for f in A2]
    # 군 → 도
    for g in adm2:
        pass
    assign, miss = {}, 0
    for t in towns:
        if 'x' not in t: continue
        lon, lat = t['x'], t['y']
        if t.get('d') == 7:                       # 유대·사마리아(서안) — 이 경계 자료에는 없음
            assign[str(t['c'])] = [-1, -1]; continue
        i2 = next((i for i, f in enumerate(A2) if inside(lon, lat, f['geometry'])), None)
        i1 = next((i for i, f in enumerate(A1) if inside(lon, lat, f['geometry'])), None)
        if i2 is None: i2, d2 = nearest(lon, lat, A2); miss += 1
        if i1 is None: i1, _ = nearest(lon, lat, A1)
        assign[str(t['c'])] = [i1, i2]
    # 군이 속한 도: 소속 지역 다수결
    for i, g in enumerate(adm2):
        votes = {}
        for a in assign.values():
            if a[1] == i: votes[a[0]] = votes.get(a[0], 0) + 1
        g['p'] = max(votes, key=votes.get) if votes else None
    xs = []; ys = []
    for f in A1 + A2:
        for poly in rings(f['geometry']):
            for lon, lat in poly[0]: x, y = proj(lon, lat); xs.append(x); ys.append(y)
    box = [math.floor(min(xs)) - 4, math.floor(min(ys)) - 4, math.ceil(max(xs) - min(xs)) + 8, math.ceil(max(ys) - min(ys)) + 8]
    out = {'note': 'Administrative boundaries courtesy of geoBoundaries.org (ADM1·ADM2, public domain). 지역 중심 좌표: data.gov.il·OpenStreetMap(navonyaniv/election-il-2026).',
           'viewBox': box, 'adm1': adm1, 'adm2': adm2, 'towns': assign}
    dst = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'map.json')
    json.dump(out, open(dst, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
    print('map.json', os.path.getsize(dst) // 1024, 'KB · towns', len(assign), '· nearest-fallback', miss, '· westbank', sum(1 for a in assign.values() if a[1] == -1))

if __name__ == '__main__':
    main(*sys.argv[1:4])

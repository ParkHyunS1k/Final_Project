"""구역 단위 미설치 판정 평가 — 이 프로젝트가 처음 재는 숫자.

지금까지의 모든 지표는 **난간이 있는 프레임에서만** 쟀다 (`targets.yaml` 의
`require: [SO-01]`). 제품이 요구하는 것은 미설치 판정인데 그것을 재는 집합이
없었다. `docs/train_results.md` 1.5절에서 507 에 그 집합이 있음을 확인했다.

**프레임 단위로 재면 안 된다.** `SO-01` 은 UC 상황에 아예 라벨되지 않는다
(`targets.yaml` 11행: 비계작업 UC 5,070프레임 SO-01 0건). 그 0건은 "난간이 없다"
가 아니라 **"라벨하지 않았다"** 이고, 실제로 미설치 프레임의 화면 다른 곳에는
난간이 보인다. 난간이 없다고 보장되는 것은 **`UC-01` 박스 안쪽뿐**이다.

그래서 구역(zone) 단위로 잰다.

    positive zone = `SO-01` 박스   (난간이 있는 비계 한 칸)
    negative zone = `UC-01` 박스   (난간이 있어야 하는데 없는 비계 한 칸)

두 구역에 **같은 판정 규칙**을 건다 — "이 구역 안에 모델이 난간을 놓았는가".
그러면 처음으로 다음 두 오류를 함께 볼 수 있다.

    난간이 있는데 못 찾음   -> 미설치라고 잘못 경보
    난간이 없는데 있다고 함 -> 실제 위반을 놓침 (안전 관점에서 더 위험)

`UC-04` 는 이동식 비계 **전체**를 잡아 단위가 다르므로 쓰지 않는다 (1.5절).
`UC-03`/`UC-06` 은 난간이 실제로 있으므로 negative 가 아니다.

각 현장은 그 현장을 **안 본** 폴드의 가중치로 잰다 (leave-one-site-out).

    python scripts/zone_eval.py D:/yolo/guardrail
"""

from __future__ import annotations

import argparse
import collections
import json
import math
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from src.data.aihub import iter_frames  # noqa: E402

LABELS = pathlib.Path(r"D:\507\label_val\122.고소작업_현장_실시간_영상_데이터"
                      r"\01.데이터\2.Validation\라벨링데이터\비계작업")
SOURCE = pathlib.Path(r"D:\507\source_val\122.고소작업_현장_실시간_영상_데이터"
                      r"\01.데이터\2.Validation\원천데이터\비계작업")
CONFS = (0.001, 0.005, 0.01, 0.05, 0.10, 0.25, 0.50)


def inter(a, b) -> float:
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    return ix * iy


def area(b) -> float:
    return max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])


def collect_zones() -> dict:
    """현장 -> {'pos': [(img, box)], 'neg': [(img, box)]}"""
    index = {p.stem: p for p in SOURCE.rglob("*.jpg")}
    out = collections.defaultdict(lambda: {"pos": [], "neg": []})
    for f in iter_frames(LABELS):
        p = f.video_id.split("_")
        if len(p) < 3 or p[2] != "A" or f.image_id not in index:
            continue
        site, img = p[1], index[f.image_id]
        for a in f.annotations:
            if a.class_code == "SO-01":
                out[site]["pos"].append((img, a.bbox))
            elif a.class_code == "UC-01":
                out[site]["neg"].append((img, a.bbox))
    return out


def union_cov(z, boxes, grid: int = 32) -> float:
    """예측들을 구역에 클리핑한 뒤 **합집합**이 구역을 덮는 비율.

    단일 박스 기준은 조각난 올바른 예측 여러 개를 놓치고, 거대한 오검출 하나는
    통과시킨다. 합집합 기준과 나란히 봐야 규칙이 결론을 바꾸는지 알 수 있다.
    구역 안을 grid x grid 로 래스터화해 센다.
    """
    if not boxes:
        return 0.0
    x1, y1, x2, y2 = z
    w, h = x2 - x1, y2 - y1
    if w <= 0 or h <= 0:
        return 0.0
    hit = bytearray(grid * grid)
    for b in boxes:
        cx1 = max(0, int((max(b[0], x1) - x1) / w * grid))
        cx2 = min(grid, int(math.ceil((min(b[2], x2) - x1) / w * grid)))
        cy1 = max(0, int((max(b[1], y1) - y1) / h * grid))
        cy2 = min(grid, int(math.ceil((min(b[3], y2) - y1) / h * grid)))
        for yy in range(cy1, cy2):
            for xx in range(cx1, cx2):
                hit[yy * grid + xx] = 1
    return sum(hit) / (grid * grid)


def judge(model, zones: list, imgsz: int) -> dict:
    """구역마다 conf 별 (최대 단일 커버율, 합집합 커버율) 과 구역 면적을 낸다.

    임계를 나중에 적용할 수 있게 커버율 자체를 보관한다. 한 번 추론으로
    cov 임계 민감도와 단일/합집합 비교를 모두 볼 수 있다.
    """
    by_img = collections.defaultdict(list)
    for img, box in zones:
        by_img[img].append(box)
    rows = []          # (zone_area_ratio, {conf: (single, union)})
    paths = sorted(by_img)
    for i in range(0, len(paths), 16):
        chunk = paths[i:i + 16]
        res = model.predict([str(q) for q in chunk], conf=min(CONFS), imgsz=imgsz,
                            verbose=False, classes=[0])
        for path, r in zip(chunk, res):
            iw, ih = r.orig_shape[1], r.orig_shape[0]
            preds = [(tuple(float(v) for v in b), float(s))
                     for b, s in zip(r.boxes.xyxy, r.boxes.conf)]
            for z in by_img[path]:
                az = area(z)
                per_conf = {}
                for c in CONFS:
                    keep = [b for b, sc in preds if sc >= c]
                    single = max((inter(z, b) / az for b in keep), default=0.0) if az else 0.0
                    per_conf[c] = (single, union_cov(z, keep))
                rows.append((az / (iw * ih) if iw * ih else 0.0, per_conf))
    return {"rows": rows, "total": len(rows)}


def rate(res: dict, conf: float, cov: float, mode: int, sel=None) -> tuple[int, int]:
    """(난간 있다고 판정한 구역 수, 대상 구역 수). mode 0=단일, 1=합집합."""
    said = n = 0
    for az, per_conf in res["rows"]:
        if sel and not sel(az):
            continue
        n += 1
        if per_conf[conf][mode] >= cov:
            said += 1
    return said, n


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("root", type=pathlib.Path)
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--cov", type=float, default=0.3,
                    help="주 표에서 쓸 커버 임계")
    ap.add_argument("--covs", type=float, nargs="+",
                    default=[0.1, 0.2, 0.3, 0.4, 0.5],
                    help="민감도 분석용 커버 임계들")
    args = ap.parse_args()

    from ultralytics import YOLO

    fold_of_site = {}
    for sj in sorted(args.root.glob("fold*/split.json")):
        a = json.loads(sj.read_text(encoding="utf-8"))["assignment"]
        for s, v in a.items():
            if v == "test":
                fold_of_site[s.split("_")[1]] = sj.parent.name

    zones = collect_zones()
    print(f"구역 단위 판정. 각 현장은 그 현장을 안 본 폴드로 잰다.")
    print(f"판정 = 구역 면적의 {args.cov:.0%} 이상을 덮는 guardrail 예측이 있음")
    print()

    got = {}
    for site in sorted(zones):
        z = zones[site]
        fold = fold_of_site.get(site)
        if not z["neg"] or not fold:
            continue
        w = args.root / "runs" / fold / "weights" / "best.pt"
        if not w.exists():
            continue
        model = YOLO(str(w))
        got[site] = (fold, judge(model, z["pos"], args.imgsz),
                     judge(model, z["neg"], args.imgsz))

    def metrics(pos, neg, conf, cov, mode, sel=None):
        ps, pn = rate(pos, conf, cov, mode, sel)
        ns, nn = rate(neg, conf, cov, mode, sel)
        if not pn or not nn:
            return None
        det = ps / pn                 # 정상 구역을 맞힘 (특이도)
        recall = 1 - ns / nn          # 미설치를 알람 (민감도)
        return det, recall, recall + det - 1, pn, nn

    # ---- 주 표
    for site, (fold, pos, neg) in got.items():
        print(f"  {site}  ({fold})  정상구역 {pos['total']} / 미설치구역 {neg['total']}")
        print(f"    {'conf':>7}{'정상구역검출':>13}{'미설치적발':>12}{'오경보율':>10}{'J':>8}")
        for c in CONFS:
            m = metrics(pos, neg, c, args.cov, 0)
            if m:
                det, rec, j, _, _ = m
                print(f"    {c:>7.3f}{det:>13.1%}{rec:>12.1%}{1 - det:>10.1%}{j:>8.3f}")
        print()

    # ---- 커버 임계 민감도 + 단일/합집합 비교 (conf 는 J 최대 = oracle)
    print("=== 커버 임계 민감도 · 단일 박스 대 합집합 (각 칸은 conf 를 훑은 oracle Jmax) ===")
    print(f"  {'현장':<6}{'cov':>6}" + "".join(f"{k:>22}" for k in ("단일 J (적발/오경보)",
                                                                   "합집합 J (적발/오경보)")))
    for site, (fold, pos, neg) in got.items():
        for cov in args.covs:
            cells = []
            for mode in (0, 1):
                best = max((metrics(pos, neg, c, cov, mode) for c in CONFS),
                           key=lambda m: (m[2] if m else -9))
                det, rec, j, _, _ = best
                cells.append(f"{j:>6.3f} ({rec:.0%}/{1 - det:.0%})")
            print(f"  {site:<6}{cov:>6.1f}" + "".join(f"{c:>22}" for c in cells))
        print()

    # ---- 면적 구간별 (크기 편향 확인). 정상·미설치 구역을 같은 면적대로 제한한다.
    print("=== 면적 구간별 (단일 기준, cov 고정, oracle Jmax) ===")
    print("  구역 크기가 같은 구간에서도 J 가 유지되면 크기 편향이 주범이 아니다.")
    bands = [(0.0, 0.05), (0.05, 0.10), (0.10, 0.20), (0.20, 1.0)]
    for site, (fold, pos, neg) in got.items():
        print(f"  {site}")
        for lo, hi in bands:
            sel = lambda a, lo=lo, hi=hi: lo <= a < hi
            cand = [metrics(pos, neg, c, args.cov, 0, sel) for c in CONFS]
            cand = [m for m in cand if m]
            if not cand:
                continue
            det, rec, j, pn, nn = max(cand, key=lambda m: m[2])
            if pn < 20 or nn < 20:
                print(f"    {lo:.2f}~{hi:.2f}  정상 {pn:>5} / 미설치 {nn:>5}  (표본 부족)")
                continue
            print(f"    {lo:.2f}~{hi:.2f}  정상 {pn:>5} / 미설치 {nn:>5}"
                  f"  J {j:>6.3f}  적발 {rec:>5.1%}  오경보 {1 - det:>5.1%}")
        print()

    print("  알람 = 모델이 그 구역에서 난간을 못 찾음. 미설치 구역에서 울리면 정답이다.")
    print("  공동 주지표는 미설치적발률과 오경보율이고 J 는 요약값이다.")
    print("  위의 J 는 전부 conf 를 test 에서 고른 oracle 값이다. 배포 성능이 아니다.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

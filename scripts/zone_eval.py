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
import random
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
    """현장 -> {'pos': [(img, box, clip)], 'neg': [(img, box, clip)]}

    클립(`video_id`)을 함께 들고 다닌다. 구역 수는 표본 수가 아니다 — 인접
    프레임은 거의 동일하므로 독립 표본은 클립 수다 (`eval_protocol.md` 4.1).
    면적 구간으로 쪼개면 클립이 1~2개로 줄어드는 칸이 생기는데, 구역 수만
    세면 그것이 보이지 않는다.
    """
    index = {p.stem: p for p in SOURCE.rglob("*.jpg")}
    out = collections.defaultdict(lambda: {"pos": [], "neg": []})
    for f in iter_frames(LABELS):
        p = f.video_id.split("_")
        if len(p) < 3 or p[2] != "A" or f.image_id not in index:
            continue
        site, img = p[1], index[f.image_id]
        for a in f.annotations:
            if a.class_code == "SO-01":
                out[site]["pos"].append((img, a.bbox, f.video_id))
            elif a.class_code == "UC-01":
                out[site]["neg"].append((img, a.bbox, f.video_id))
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


def judge(model, zones: list, imgsz: int, confs: tuple) -> dict:
    """구역마다 conf 별 (최대 단일 커버율, 합집합 커버율) 과 구역 면적을 낸다.

    임계를 나중에 적용할 수 있게 커버율 자체를 보관한다. 한 번 추론으로
    cov 임계 민감도와 단일/합집합 비교를 모두 볼 수 있다.
    """
    by_img = collections.defaultdict(list)
    for img, box, clip in zones:
        by_img[img].append((box, clip))
    rows = []          # (zone_area_ratio, {conf: (single, union)}, clip)
    paths = sorted(by_img)
    for i in range(0, len(paths), 16):
        chunk = paths[i:i + 16]
        res = model.predict([str(q) for q in chunk], conf=min(confs), imgsz=imgsz,
                            verbose=False, classes=[0])
        for path, r in zip(chunk, res):
            iw, ih = r.orig_shape[1], r.orig_shape[0]
            preds = [(tuple(float(v) for v in b), float(s))
                     for b, s in zip(r.boxes.xyxy, r.boxes.conf)]
            for z, clip in by_img[path]:
                az = area(z)
                per_conf = {}
                for c in confs:
                    keep = [b for b, sc in preds if sc >= c]
                    single = max((inter(z, b) / az for b in keep), default=0.0) if az else 0.0
                    per_conf[c] = (single, union_cov(z, keep))
                rows.append((az / (iw * ih) if iw * ih else 0.0, per_conf, clip))
    return {"rows": rows, "total": len(rows)}


def rate(res: dict, conf: float, cov: float, mode: int, sel=None) -> tuple[int, int, int]:
    """(난간 있다고 판정한 구역 수, 대상 구역 수, 클립 수). mode 0=단일, 1=합집합."""
    said = n = 0
    clips = set()
    for az, per_conf, clip in res["rows"]:
        if sel and not sel(az):
            continue
        n += 1
        clips.add(clip)
        if per_conf[conf][mode] >= cov:
            said += 1
    return said, n, len(clips)


def per_clip(res: dict, conf: float, cov: float, mode: int, sel=None) -> dict:
    """클립 -> [판정 수, 구역 수]. 주지표를 클립 단위로 집계하기 위한 것.

    구역 수로 나누면 큰 클립이 지표를 지배한다 — A04 정상 4,306구역은 16클립에서
    나온다. `eval_protocol.md` 4.1 이 클립/세션 블록 단위 집계를 요구한다.
    """
    out = collections.defaultdict(lambda: [0, 0])
    for az, per_conf, clip in res["rows"]:
        if sel and not sel(az):
            continue
        cell = out[clip]
        cell[1] += 1
        cell[0] += per_conf[conf][mode] >= cov
    return out


def boot_ci(vals: list, reps: int = 1000, seed: int = 0) -> tuple | None:
    """클립 단위 백분위 bootstrap 95% 구간.

    클립이 2~9개뿐이라 구간이 넓게 나오는 것이 정상이다. 좁게 보이면 그것이
    이상한 것이다 — 넓은 구간 자체가 이 데이터로 할 수 있는 주장의 한계다.
    """
    if len(vals) < 2:
        return None
    rnd = random.Random(seed)
    means = sorted(sum(rnd.choice(vals) for _ in range(len(vals))) / len(vals)
                   for _ in range(reps))
    return means[int(0.025 * reps)], means[int(0.975 * reps)]


def paired_bands(res: dict, conf: float, cov: float, bands: list, mode: int = 0,
                 min_zones: int = 20) -> list:
    """면적대 **쌍**마다 공통 클립에서만 검출률 차이를 낸다.

    면적 구간 비교의 교란: 큰 구역은 가까이 찍은 클립에서 나온다. 구간별 차이가
    "크면 잘 된다" 인지 "가까이 찍은 클립이 쉬웠다" 인지 구분되지 않는다.
    두 면적대를 **모두** 가진 클립만 골라 클립별 차이를 내고 그 차이를 평균하면
    촬영 조건이 상수가 된다. 구간마다 다른 클립 집합을 합치면 paired 가 아니다.

    J 는 낼 수 없다 — 정상 클립과 미설치 클립이 완전히 분리돼 있다
    (`train_results.md` 1.5, 겹침 0). 그래서 한쪽 집합의 검출률만 낸다.
    정상 구역이면 높을수록 좋고(오경보의 반대), 미설치 구역이면 낮을수록 좋다.

    반환: [(band_a, band_b, 공통클립수, a평균, b평균, 평균차)]
    """
    per = collections.defaultdict(dict)          # clip -> band -> [said, n]
    for az, per_conf, clip in res["rows"]:
        for b in bands:
            if b[0] <= az < b[1]:
                cell = per[clip].setdefault(b, [0, 0])
                cell[1] += 1
                cell[0] += per_conf[conf][mode] >= cov
                break
    out = []
    for i in range(len(bands)):
        for j in range(i + 1, len(bands)):
            a, b = bands[i], bands[j]
            pairs = []
            for bs in per.values():
                if (a in bs and b in bs
                        and bs[a][1] >= min_zones and bs[b][1] >= min_zones):
                    pairs.append((bs[a][0] / bs[a][1], bs[b][0] / bs[b][1]))
            if pairs:
                out.append((a, b, len(pairs),
                            sum(p[0] for p in pairs) / len(pairs),
                            sum(p[1] for p in pairs) / len(pairs),
                            sum(p[1] - p[0] for p in pairs) / len(pairs)))
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("root", type=pathlib.Path)
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--cov", type=float, default=0.3,
                    help="주 표에서 쓸 커버 임계")
    ap.add_argument("--covs", type=float, nargs="+",
                    default=[0.1, 0.2, 0.3, 0.4, 0.5],
                    help="민감도 분석용 커버 임계들")
    ap.add_argument("--fixed-conf", type=float, nargs="+", default=None,
                    help="면적 구간 표의 conf 를 이 값(들)으로 고정한다. 주면 구간마다 "
                         "conf 를 고르지 않으므로 크기 효과를 임계 튜닝으로 만들어낼 수 "
                         "없다. 여러 값을 주면 추론 한 번으로 표를 여러 장 낸다")
    args = ap.parse_args()

    confs = tuple(sorted(set(CONFS) | set(args.fixed_conf or ())))

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
        got[site] = (fold, judge(model, z["pos"], args.imgsz, confs),
                     judge(model, z["neg"], args.imgsz, confs))

    def metrics(pos, neg, conf, cov, mode, sel=None):
        """주지표는 클립 macro, 구역 가중치는 기술통계로 함께 낸다.

        det = 정상 구역을 맞힘 (오경보의 반대), rec = 미설치를 알람.
        `m` 접두사가 클립 macro 다. `eval_protocol.md` 4.1 에 따라 이쪽이 주지표다.
        """
        ps, pn, pc = rate(pos, conf, cov, mode, sel)
        ns, nn, nc = rate(neg, conf, cov, mode, sel)
        if not pn or not nn:
            return None
        pv = [s / n for s, n in per_clip(pos, conf, cov, mode, sel).values()]
        nv = [1 - s / n for s, n in per_clip(neg, conf, cov, mode, sel).values()]
        mdet, mrec = sum(pv) / len(pv), sum(nv) / len(nv)
        return {"det": ps / pn, "rec": 1 - ns / nn, "j": (1 - ns / nn) + ps / pn - 1,
                "pn": pn, "nn": nn, "pc": pc, "nc": nc,
                "mdet": mdet, "mrec": mrec, "mj": mdet + mrec - 1,
                "dci": boot_ci(pv), "rci": boot_ci(nv)}

    # ---- 주 표. 클립 macro 가 주지표, 대괄호는 클립 bootstrap 95% 구간
    for site, (fold, pos, neg) in got.items():
        m0 = metrics(pos, neg, min(confs), args.cov, 0)
        print(f"  {site}  ({fold})  정상구역 {pos['total']}({m0['pc']}클립) / "
              f"미설치구역 {neg['total']}({m0['nc']}클립)")
        for c in confs:
            m = metrics(pos, neg, c, args.cov, 0)
            if not m:
                continue
            dci = f"[{m['rci'][0]:.0%}-{m['rci'][1]:.0%}]" if m["rci"] else "[구간불가]"
            fci = f"[{1 - m['dci'][1]:.0%}-{1 - m['dci'][0]:.0%}]" if m["dci"] else "[구간불가]"
            print(f"    conf {c:<5.3f} 적발 {m['mrec']:>5.1%} {dci:<11} "
                  f"오경보 {1 - m['mdet']:>5.1%} {fci:<11} J {m['mj']:>6.3f}"
                  f"   (구역가중 {m['rec']:.1%}/{1 - m['det']:.1%})")
        print()

    # ---- 커버 임계 민감도 + 단일/합집합 비교 (conf 는 J 최대 = oracle)
    print("=== 커버 임계 민감도 · 단일 박스 대 합집합 (각 칸은 conf 를 훑은 oracle Jmax) ===")
    print("  클립 macro 기준. oracle 이므로 배포 성능이 아니다.")
    print(f"  {'현장':<6}{'cov':>6}" + "".join(f"{k:>22}" for k in ("단일 J (적발/오경보)",
                                                                   "합집합 J (적발/오경보)")))
    for site, (fold, pos, neg) in got.items():
        for cov in args.covs:
            cells = []
            for mode in (0, 1):
                best = max((metrics(pos, neg, c, cov, mode) for c in confs),
                           key=lambda m: (m["mj"] if m else -9))
                cells.append(f"{best['mj']:>6.3f} "
                             f"({best['mrec']:.0%}/{1 - best['mdet']:.0%})")
            print(f"  {site:<6}{cov:>6.1f}" + "".join(f"{c:>22}" for c in cells))
        print()

    # ---- 면적 구간별 (크기 편향 확인). 정상·미설치 구역을 같은 면적대로 제한한다.
    bands = [(0.0, 0.05), (0.05, 0.10), (0.10, 0.20), (0.20, 1.0)]

    def area_table(fixed: float | None) -> None:
        if fixed:
            print(f"=== 면적 구간별 (단일 기준, cov {args.cov}, conf {fixed} 고정) ===")
            print("  전 현장·전 구간에 같은 conf 를 건다. 구간마다 임계를 고르지 않으므로")
            print("  크기 효과가 임계 튜닝의 산물일 가능성이 배제된다.")
        else:
            print("=== 면적 구간별 (단일 기준, cov 고정, oracle Jmax) ===")
            print("  구간마다 conf 를 test 에서 고른다. 크기 효과의 상한이다.")
        print("  괄호는 클립 수. 독립 표본은 구역이 아니라 클립이다 (eval_protocol 4.1).")
        for site, (fold, pos, neg) in got.items():
            print(f"  {site}")
            for lo, hi in bands:
                sel = lambda a, lo=lo, hi=hi: lo <= a < hi
                if fixed:
                    m = metrics(pos, neg, fixed, args.cov, 0, sel)
                else:
                    cand = [x for x in (metrics(pos, neg, c, args.cov, 0, sel)
                                        for c in confs) if x]
                    m = max(cand, key=lambda x: x["mj"]) if cand else None
                if not m:
                    continue
                head = (f"    {lo:.2f}~{hi:.2f}  정상 {m['pn']:>5} ({m['pc']}클립) / "
                        f"미설치 {m['nn']:>5} ({m['nc']}클립)")
                if m["pn"] < 20 or m["nn"] < 20:
                    print(f"{head}  (구역 부족)")
                    continue
                weak = "  ※클립 부족" if min(m["pc"], m["nc"]) < 5 else ""
                print(f"{head}  J {m['mj']:>6.3f}  적발 {m['mrec']:>5.1%}"
                      f"  오경보 {1 - m['mdet']:>5.1%}{weak}")
            print()

    area_table(None)
    for fixed in args.fixed_conf or ():
        area_table(fixed)

    # ---- 면적대 paired 비교. 같은 클립이 두 구간을 다 가진 경우만 쓴다.
    for fixed in args.fixed_conf or ():
        print(f"=== 면적대 paired 비교 (cov {args.cov}, conf {fixed} 고정) ===")
        print("  두 면적대를 **모두** 가진 클립만 골라 클립별 차이를 내고 평균한다.")
        print("  촬영 거리·조명·세션이 상수가 되므로 크기 효과와 클립 난이도가 분리된다.")
        for site, (fold, pos, neg) in got.items():
            for nm, res in (("정상 검출률(↑좋음)", pos), ("미설치 검출률(↓좋음)", neg)):
                for a, b, k, ra, rb, d in paired_bands(res, fixed, args.cov, bands):
                    print(f"  {site:<5}{nm:<20}{a[0]:.2f}~{a[1]:.2f} → {b[0]:.2f}~{b[1]:.2f}"
                          f"  공통 {k}클립  {ra:>5.1%} → {rb:>5.1%}  (Δ {d:+.1%}p)")
        print()

    print("  알람 = 모델이 그 구역에서 난간을 못 찾음. 미설치 구역에서 울리면 정답이다.")
    print("  공동 주지표는 미설치적발률과 오경보율이고 J 는 요약값이다.")
    print("  주지표는 클립 macro 다. 구역 가중치는 기술통계로만 병기한다 (eval_protocol 4.1).")
    print("  oracle 표시가 붙은 표만 conf 를 test 에서 골랐다. 고정 임계 표는 oracle 이 아니다.")
    print("  어느 쪽이든 네 현장은 development CV 이므로 합격 판정에 쓸 수 없다 (4.4).")
    return 0


if __name__ == "__main__":
    sys.exit(main())

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


def judge(model, zones: list, imgsz: int, cov_thr: float) -> dict:
    """conf 별 '이 구역에 난간이 있다' 고 판정한 구역 수."""
    by_img = collections.defaultdict(list)
    for img, box in zones:
        by_img[img].append(box)
    said = {c: 0 for c in CONFS}
    total = 0
    paths = sorted(by_img)
    for i in range(0, len(paths), 16):
        chunk = paths[i:i + 16]
        res = model.predict([str(q) for q in chunk], conf=min(CONFS), imgsz=imgsz,
                            verbose=False, classes=[0])
        for path, r in zip(chunk, res):
            preds = [(tuple(float(v) for v in b), float(s))
                     for b, s in zip(r.boxes.xyxy, r.boxes.conf)]
            for z in by_img[path]:
                total += 1
                az = area(z)
                for c in CONFS:
                    # 구역 면적의 cov_thr 이상을 덮는 예측이 있으면 "난간 있음" 판정.
                    # IoU 를 쓰지 않는 이유: negative 구역은 난간이 없어 칸 전체를
                    # 잡으므로 positive 구역보다 크다(면적비 0.111 대 0.058).
                    # IoU 는 그 크기 차이 때문에 두 구역을 다른 잣대로 재게 된다.
                    if any(s >= c and az > 0 and inter(z, b) / az >= cov_thr
                           for b, s in preds):
                        said[c] += 1
    return {"said": said, "total": total}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("root", type=pathlib.Path)
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--cov", type=float, default=0.3,
                    help="구역 면적 중 예측이 덮어야 하는 비율")
    args = ap.parse_args()

    from ultralytics import YOLO

    # 현장 -> 그 현장을 test 로 둔 폴드(= 그 현장을 안 본 가중치)
    fold_of_site = {}
    for sj in sorted(args.root.glob("fold*/split.json")):
        a = json.loads(sj.read_text(encoding="utf-8"))["assignment"]
        for s, v in a.items():
            if v == "test":
                fold_of_site[s.split("_")[1]] = sj.parent.name

    zones = collect_zones()
    print(f"구역 단위 판정 (구역 면적의 {args.cov:.0%} 이상을 덮으면 '난간 있음')")
    print("각 현장은 그 현장을 안 본 폴드로 잰다.\n")

    for site in sorted(zones):
        z = zones[site]
        fold = fold_of_site.get(site)
        if not z["neg"] or not fold:
            continue
        w = args.root / "runs" / fold / "weights" / "best.pt"
        if not w.exists():
            continue
        model = YOLO(str(w))
        pos = judge(model, z["pos"], args.imgsz, args.cov)
        neg = judge(model, z["neg"], args.imgsz, args.cov)
        print(f"  {site}  ({fold} 가중치)  정상구역 {pos['total']} / 미설치구역 {neg['total']}")
        print(f"    {'conf':>7}{'정상구역검출':>13}{'미설치적발':>12}"
              f"{'오경보율':>10}{'J':>8}{'정밀도*':>9}{'F1*':>8}")
        for c in CONFS:
            det = pos["said"][c] / max(1, pos["total"])       # 정상 구역을 맞힘
            recall = 1 - neg["said"][c] / max(1, neg["total"])  # 미설치를 알람
            fa = 1 - det                                       # 정상인데 알람 = 오경보
            tp = recall * neg["total"]
            fp = fa * pos["total"]
            prec = tp / (tp + fp) if tp + fp else 0.0
            f1 = 2 * prec * recall / (prec + recall) if prec + recall else 0.0
            # Youden's J = 민감도 + 특이도 - 1. 유병률과 무관하고, 아무것도
            # 검출하지 않아 적발률만 100% 가 되는 퇴화 해를 0 으로 만든다.
            j = recall + det - 1
            print(f"    {c:>7.3f}{det:>13.1%}{recall:>12.1%}{fa:>10.1%}"
                  f"{j:>8.3f}{prec:>9.1%}{f1:>8.3f}")
        print()

    print("  알람 = 모델이 그 구역에서 난간을 못 찾음. 미설치 구역에서 울리면 정답이다.")
    print("  J = 미설치적발률 + 정상구역검출률 - 1. 0 이면 무작위와 같다.")
    print("    아무것도 검출하지 않으면 적발률이 100% 가 되지만 J 는 0 이 된다.")
    print("  '미설치 적발' 과 '오경보율' 이 주지표다 — 둘은 유병률과 무관하다.")
    print("  * 정밀도/F1 은 이 평가셋의 정상:미설치 비율에 의존한다. 실제 현장은")
    print("    정상 구역이 훨씬 많으므로 배포 시 정밀도는 이보다 낮다. 참고값이다.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

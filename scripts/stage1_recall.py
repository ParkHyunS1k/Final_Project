"""1단계 크롭 제공자 비교 — COCO 사전학습 person 대 학습한 hook_stage1.

`docs/HANDOFF.md` ①. 묻는 것은 하나다: **VLM 에 넘길 작업자 크롭을 누가 더 잘
만드는가.** 크롭 제공이 목적이면 필요한 것은 회수율(작업자를 놓치지 않는가)이다.

기존 `hook_probe.py` 2단계는 COCO person 을 "사람이 몇 명인가" 의 기준자로 썼기
때문에 COCO 자신을 평가할 수 없었다(자기 자신이 정답이라 순환한다). 여기서는
**사람이 라벨한 `WO-01`(작업자)** 을 정답으로 둔다.

`WO-01` 은 비계작업 파티션에 있고 현장이 11곳이다. hook_stage1 은 공통 UA 의
현장 A03 한 곳으로만 학습했으므로, 나머지 10개 현장이 곧 **학습 분포 밖**이다.
(A03 은 파티션·상황유형이 다르지만 같은 현장이라 따로 표시한다.)

정밀도는 재지 않는다. 이 파티션은 프레임당 `WO-01` 이 약 1개라 화면의 모든
작업자가 라벨된 것인지 알 수 없고, 라벨 안 된 작업자를 잡은 검출을 오검출로
셀 수 없기 때문이다. 회수율은 정답 박스만 있으면 정의된다.

    python scripts/stage1_recall.py --model D:/yolo/hook_stage1/runs/all_train/weights/best.pt
"""

from __future__ import annotations

import argparse
import collections
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from src.data.aihub import iter_frames  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[1]
LABELS = pathlib.Path(r"D:\507\label_val\122.고소작업_현장_실시간_영상_데이터"
                      r"\01.데이터\2.Validation\라벨링데이터\비계작업")
SOURCE = pathlib.Path(r"D:\507\source_val\122.고소작업_현장_실시간_영상_데이터"
                      r"\01.데이터\2.Validation\원천데이터\비계작업")
TRAIN_SITE = "A03"  # hook_stage1 이 본 유일한 현장


def iou(a, b) -> float:
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    ix, iy = max(0.0, min(ax2, bx2) - max(ax1, bx1)), max(0.0, min(ay2, by2) - max(ay1, by1))
    inter = ix * iy
    ua = (ax2 - ax1) * (ay2 - ay1) + (bx2 - bx1) * (by2 - by1) - inter
    return inter / ua if ua > 0 else 0.0


def collect(per_site: int) -> dict[str, list]:
    index = {p.stem: p for p in SOURCE.rglob("*.jpg")}
    by_site: dict[str, list] = collections.defaultdict(list)
    for f in iter_frames(LABELS):
        gt = [a.bbox for a in f.annotations if a.class_code == "WO-01"]
        if not gt or f.image_id not in index:
            continue
        parts = f.video_id.split("_")
        site = parts[1] if len(parts) > 1 else "?"
        by_site[site].append((index[f.image_id], gt))
    # 한 현장이 표본을 독점하지 않도록 균등하게 자른다. 클립이 시간순이라
    # 앞에서 자르면 한 클립만 남으므로 등간격으로 뽑는다.
    for site, items in by_site.items():
        if len(items) > per_site:
            step = len(items) / per_site
            by_site[site] = [items[int(i * step)] for i in range(per_site)]
    return dict(sorted(by_site.items()))


def recall(model, frames, conf_lo: float, confs: tuple[float, ...],
           thr: float) -> dict[float, tuple[int, int]]:
    """conf 별 (덮인 정답 수, 전체 정답 수)."""
    hit = {c: 0 for c in confs}
    total = 0
    for i in range(0, len(frames), 16):
        chunk = frames[i:i + 16]
        res = model.predict([str(p) for p, _ in chunk], conf=conf_lo, imgsz=640,
                            verbose=False, **model_kwargs(model))
        for (_, gt), r in zip(chunk, res):
            boxes = [(tuple(float(v) for v in b), float(s))
                     for b, s in zip(r.boxes.xyxy, r.boxes.conf)]
            total += len(gt)
            for g in gt:
                for c in confs:
                    if any(s >= c and iou(g, b) >= thr for b, s in boxes):
                        hit[c] += 1
    return {c: (hit[c], total) for c in confs}


def model_kwargs(model) -> dict:
    # COCO 는 person(0)만, 학습 모델은 단일 클래스라 필터가 필요 없다.
    return {"classes": [0]} if len(model.names) > 1 else {}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", type=pathlib.Path, required=True)
    ap.add_argument("--coco", type=pathlib.Path, default=ROOT / "yolo26s.pt")
    ap.add_argument("--per-site", type=int, default=150)
    ap.add_argument("--iou", type=float, default=0.5)
    args = ap.parse_args()

    confs = (0.25, 0.50)
    by_site = collect(args.per_site)

    from ultralytics import YOLO
    models = {"COCO person": YOLO(str(args.coco)), "hook_stage1": YOLO(str(args.model))}

    print(f"정답 = 비계작업 WO-01(작업자), IoU >= {args.iou}, 현장당 최대 {args.per_site}프레임")
    print(f"hook_stage1 학습 현장 = {TRAIN_SITE} (공통 UA). 나머지는 학습 분포 밖.\n")
    header = f"{'현장':<6}{'프레임':>7}{'정답':>7}"
    for name in models:
        for c in confs:
            header += f"{name + ' @' + str(c):>22}"
    print(header)

    agg = {(n, c): [0, 0] for n in models for c in confs}
    for site, frames in by_site.items():
        row = f"{site:<6}{len(frames):>7}"
        got = {}
        for name, m in models.items():
            got[name] = recall(m, frames, min(confs), confs, args.iou)
        row += f"{got['COCO person'][confs[0]][1]:>7}"
        for name in models:
            for c in confs:
                h, t = got[name][c]
                row += f"{(f'{h}/{t} = {h / t:.1%}' if t else '-'):>22}"
                if site != TRAIN_SITE:
                    agg[(name, c)][0] += h
                    agg[(name, c)][1] += t
        print(row + ("   <- 학습 현장" if site == TRAIN_SITE else ""))

    print(f"\n{'학습 분포 밖 합계':<13}")
    for name in models:
        parts = []
        for c in confs:
            h, t = agg[(name, c)]
            parts.append(f"@{c} {h}/{t} = {h / t:.1%}" if t else "-")
        print(f"  {name:<14}{'   '.join(parts)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

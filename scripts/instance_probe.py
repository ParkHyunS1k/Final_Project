"""guardrail 이 "난간을 못 찾는" 것인지 "칸을 못 나누는" 것인지 가른다.

A04 가 test 인 fold3 은 어느 클래스 구성에서도 혼자 무너진다 (AP@0.5 0.084 /
0.171). 육안으로 보면 라벨 관행은 네 현장이 같다 — 비계 한 칸에 박스 하나다.
다른 것은 **카메라 거리**다. A08 은 한두 칸이 화면을 채우고, A04 는 여러 층짜리
비계 전체가 들어와 거의 똑같이 생긴 칸 4~6개가 격자로 이어 붙는다.

이어 붙은 칸들은 기둥과 가로대를 공유하므로 경계가 어디인지가 모호하다.
박스가 반 칸씩 밀리거나 두 칸을 한 박스로 묶으면 **IoU 0.5 를 전부 놓친다** —
난간을 정확히 봤더라도 AP 는 0 이 된다.

그래서 세 가지를 같이 잰다.

  1. IoU 임계 0.5 / 0.3 / 0.1 회수율. 임계를 낮출 때 급격히 오르면 위치는
     맞는데 경계가 틀린 것이다.
  2. 프레임당 예측 개수 대 정답 개수. 1보다 작으면 칸을 묶고 있다는 뜻이다.
  3. **합집합 IoU** — 예측 전체의 합집합과 정답 전체의 합집합을 픽셀로 비교한다.
     개별 박스를 어떻게 쪼갰든 "난간이 있는 영역" 을 맞혔는지만 본다.
     이것이 높은데 (1) 이 낮으면 탐지 문제가 아니라 인스턴스 분할 문제다.

각 폴드는 자기 test 현장을 안 보고 학습한 모델로 잰다 (leave-one-site-out).

    python scripts/instance_probe.py D:/yolo/guardrail
"""

from __future__ import annotations

import argparse
import collections
import json
import pathlib
import sys

import numpy as np


def load_gt(label_path: pathlib.Path, w: int, h: int) -> list:
    out = []
    if not label_path.exists():
        return out
    for line in label_path.read_text().splitlines():
        p = line.split()
        if not p or p[0] != "0":  # guardrail 만
            continue
        cx, cy, bw, bh = (float(v) for v in p[1:5])
        out.append(((cx - bw / 2) * w, (cy - bh / 2) * h,
                    (cx + bw / 2) * w, (cy + bh / 2) * h))
    return out


def iou(a, b) -> float:
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    ix = max(0.0, min(ax2, bx2) - max(ax1, bx1))
    iy = max(0.0, min(ay2, by2) - max(ay1, by1))
    inter = ix * iy
    ua = (ax2 - ax1) * (ay2 - ay1) + (bx2 - bx1) * (by2 - by1) - inter
    return inter / ua if ua > 0 else 0.0


def union_iou(pred: list, gt: list, w: int, h: int, scale: int = 8) -> float:
    """박스 합집합끼리의 IoU. 마스크를 1/8 해상도로 그려 비교한다."""
    if not gt:
        return float("nan")
    W, H = max(1, w // scale), max(1, h // scale)
    mp, mg = np.zeros((H, W), bool), np.zeros((H, W), bool)
    for boxes, m in ((pred, mp), (gt, mg)):
        for x1, y1, x2, y2 in boxes:
            m[max(0, int(y1 / scale)):int(y2 / scale) + 1,
              max(0, int(x1 / scale)):int(x2 / scale) + 1] = True
    u = (mp | mg).sum()
    return float((mp & mg).sum() / u) if u else float("nan")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("root", type=pathlib.Path)
    # AP 는 PR 곡선을 conf~0 까지 적분한 값이다. conf 0.25 로 재면 AP 가 0.42 인
    # 폴드가 프레임당 0.00개를 내는 모순이 생긴다 (실제로 그렇게 나왔다).
    # 탐지 능력을 보려면 낮은 conf 로, 운용 시점을 보려면 높은 conf 로 봐야 한다.
    ap.add_argument("--conf", type=float, default=0.01)
    ap.add_argument("--imgsz", type=int, default=640,
                    help="학습 때 쓴 값과 같아야 한다. 다르면 비교가 성립하지 않는다")
    ap.add_argument("--op-conf", type=float, default=0.25,
                    help="운용 시점 비교용 conf. 이 값 이상만 남겼을 때의 개수·회수율도 같이 찍는다")
    ap.add_argument("--sweep", action="store_true",
                    help="conf 를 훑어 guardrail 단일 클래스의 P/R/F1 을 찍는다. "
                         "운용점을 다시 고르면 회수율이 얼마나 오르는지 본다")
    args = ap.parse_args()

    from PIL import Image
    from ultralytics import YOLO

    thresholds = (0.5, 0.3, 0.1)
    print(f"conf {args.conf} (AP 와 같은 저신뢰 구간) / 운용 conf {args.op_conf}")
    print()
    print(f"{'fold':<7}{'현장':<6}{'프레임':>7}{'정답/f':>8}{'예측/f':>8}{'운용예측/f':>11}"
          + "".join(f"{'회수@' + str(t):>10}" for t in thresholds)
          + f"{'운용회수@.5':>12}{'합집합IoU':>11}")

    for fold_dir in sorted(args.root.glob("fold*")):
        if not (fold_dir / "images" / "test").is_dir():
            continue
        weights = args.root / "runs" / fold_dir.name / "weights" / "best.pt"
        if not weights.exists():
            print(f"{fold_dir.name}: 가중치 없음 {weights}")
            continue
        site = sorted({s.split("_")[1] for s, v in json.loads(
            (fold_dir / "split.json").read_text(encoding="utf-8"))["assignment"].items()
            if v == "test"})[0]

        imgs = sorted((fold_dir / "images" / "test").glob("*.jpg"))
        model = YOLO(str(weights))
        n_gt = n_pred = n_op = 0
        hit = {t: 0 for t in thresholds}
        op_hit = 0
        uious = []
        for i in range(0, len(imgs), 16):
            chunk = imgs[i:i + 16]
            res = model.predict([str(p) for p in chunk], conf=args.conf,
                                imgsz=args.imgsz, verbose=False, classes=[0])
            for path, r in zip(chunk, res):
                w, h = Image.open(path).size
                gt = load_gt(fold_dir / "labels" / "test" / f"{path.stem}.txt", w, h)
                scored = sorted(((tuple(float(v) for v in b), float(c))
                                 for b, c in zip(r.boxes.xyxy, r.boxes.conf)),
                                key=lambda t: -t[1])
                pred = [b for b, _ in scored]
                op = [b for b, c in scored if c >= args.op_conf]
                n_gt += len(gt)
                n_pred += len(pred)
                n_op += len(op)
                for g in gt:
                    best = max((iou(g, p) for p in pred), default=0.0)
                    for t in thresholds:
                        hit[t] += best >= t
                    op_hit += max((iou(g, p) for p in op), default=0.0) >= 0.5
                if gt:
                    # 상위 |GT| 개만 쓴다. conf 0.01 의 수백 개를 다 합치면
                    # 화면을 덮어 합집합 IoU 가 의미를 잃는다. "개수를 알려줬을 때
                    # 제자리에 놓는가" 를 묻는 것이다.
                    uious.append(union_iou(pred[:len(gt)], gt, w, h))

        n = len(imgs)
        row = (f"{fold_dir.name:<7}{site:<6}{n:>7}{n_gt / n:>8.2f}{n_pred / n:>8.1f}"
               f"{n_op / n:>11.2f}"
               + "".join(f"{hit[t] / max(1, n_gt):>10.1%}" for t in thresholds)
               + f"{op_hit / max(1, n_gt):>12.1%}")
        print(row + f"{np.nanmean(uious):>11.3f}")

    print("\n  회수율이 임계를 낮출 때 크게 오르고 합집합 IoU 가 높으면, "
          "난간을 못 찾는 게 아니라 칸 경계를 못 맞추는 것이다.")
    if args.sweep:
        sweep(args, YOLO, Image)
    return 0


def sweep(args, YOLO, Image) -> None:
    """conf 별 guardrail P/R/F1. 매칭은 신뢰도 순 탐욕(IoU>=0.5, 정답 1개당 1회).

    운용점을 다시 고르는 것만으로 회수율이 얼마나 오르는지 본다. 재학습이 없으니
    공짜다. 다만 test 현장으로 운용점을 고르면 그 현장에 맞춘 값이 되므로,
    여기서 나온 conf 를 그대로 배포에 쓰면 안 된다 — 폭이 얼마인지만 본다.
    """
    confs = [0.001, 0.003, 0.005, 0.01, 0.05, 0.10, 0.15, 0.20, 0.25, 0.35, 0.50]
    print("\n=== conf 운용점 재선택 (guardrail, IoU 0.5) ===")
    for fold_dir in sorted(args.root.glob("fold*")):
        weights = args.root / "runs" / fold_dir.name / "weights" / "best.pt"
        if not (fold_dir / "images" / "test").is_dir() or not weights.exists():
            continue
        site = sorted({s.split("_")[1] for s, v in json.loads(
            (fold_dir / "split.json").read_text(encoding="utf-8"))["assignment"].items()
            if v == "test"})[0]
        imgs = sorted((fold_dir / "images" / "test").glob("*.jpg"))
        model = YOLO(str(weights))
        tp, fp = collections.Counter(), collections.Counter()
        n_gt = 0
        for i in range(0, len(imgs), 16):
            chunk = imgs[i:i + 16]
            res = model.predict([str(q) for q in chunk], conf=min(confs),
                                imgsz=args.imgsz, verbose=False, classes=[0])
            for path, r in zip(chunk, res):
                w, h = Image.open(path).size
                gt = load_gt(fold_dir / "labels" / "test" / f"{path.stem}.txt", w, h)
                n_gt += len(gt)
                scored = sorted(((tuple(float(v) for v in b), float(c))
                                 for b, c in zip(r.boxes.xyxy, r.boxes.conf)),
                                key=lambda t: -t[1])
                for c in confs:
                    taken = set()
                    for b, sc in scored:
                        if sc < c:
                            break
                        j, best = -1, 0.5
                        for k, g in enumerate(gt):
                            v = iou(g, b)
                            if k not in taken and v >= best:
                                j, best = k, v
                        if j >= 0:
                            taken.add(j)
                            tp[c] += 1
                        else:
                            fp[c] += 1
        print(f"\n  {fold_dir.name} / {site}  (정답 {n_gt})")
        print(f"    {'conf':>6}{'precision':>11}{'recall':>9}{'F1':>8}")
        for c in confs:
            pr = tp[c] / max(1, tp[c] + fp[c])
            rc = tp[c] / max(1, n_gt)
            f1 = 2 * pr * rc / (pr + rc) if pr + rc else 0.0
            print(f"    {c:>6.3f}{pr:>11.3f}{rc:>9.3f}{f1:>8.3f}")


if __name__ == "__main__":
    sys.exit(main())

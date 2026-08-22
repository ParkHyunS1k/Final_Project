"""해상도 민감도 probe — 재학습 없이 640 대 960 을 같은 프레임에서 비교한다.

`docs/HANDOFF.md` ②‴. 960 4폴드 재학습(2~3시간)을 정당화할 근거가 있는지 먼저 본다.
지금 근거는 "A04 난간 면적비 0.048" 하나인데 약하다 — A17 은 0.062 로 거의 같은데
회수율이 3.5배다 (`docs/train_results.md` 1.2절).

**같은 conf 로 비교하지 않는다.** 해상도가 바뀌면 신뢰도 분포가 통째로 움직여서
같은 conf 가 같은 운용점이 아니다. 대신 **같은 오검출 예산(FP/frame)** 에서
회수율을 비교한다. 그리고 정답 박스의 **최소 변 길이 구간별로 분해**한다 —
해상도가 원인이라면 이득이 작은 박스에만 몰려야 한다.

**해석의 한계.** 640 으로 학습한 모델을 960 으로 추론하는 것은 학습 해상도를
올리는 것과 다르다. 학습/추론 스케일이 어긋나므로:

  - 960 이 **이기면** 해상도가 제약이라는 강한 근거다 (불리한 조건에서 이겼다).
  - 960 이 **지면** 근거가 약하다. 스케일 불일치 탓일 수 있다.

    python scripts/imgsz_probe.py D:/yolo/guardrail
"""

from __future__ import annotations

import argparse
import collections
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from src.eval.operating_point import iou, load_gt  # noqa: E402

# FP/frame 예산. 이 값들에서 회수율을 비교한다.
BUDGETS = (0.25, 0.5, 1.0, 2.0)
# 정답 박스 최소 변(원본 px) 구간. 해상도 효과는 작은 쪽에 몰려야 한다.
BINS = ((0, 80), (80, 160), (160, 320), (320, 10 ** 9))
CONFS = tuple(round(x, 4) for x in
              (0.001, 0.002, 0.003, 0.005, 0.0075, 0.01, 0.015, 0.02, 0.03,
               0.05, 0.07, 0.10, 0.15, 0.20, 0.30, 0.40, 0.50))


def bin_of(box) -> int:
    x1, y1, x2, y2 = box
    m = min(x2 - x1, y2 - y1)
    for i, (lo, hi) in enumerate(BINS):
        if lo <= m < hi:
            return i
    return len(BINS) - 1


def measure(model, images, labels_dir, imgsz: int, cls: int = 0) -> dict:
    """conf 별 (tp, fp) 와 구간별 tp. 매칭은 신뢰도 순 탐욕, IoU>=0.5."""
    from PIL import Image

    tp = collections.Counter()
    fp = collections.Counter()
    tp_bin = collections.Counter()   # (conf, bin)
    n_gt = 0
    n_gt_bin = collections.Counter()
    for i in range(0, len(images), 16):
        chunk = images[i:i + 16]
        res = model.predict([str(p) for p in chunk], conf=min(CONFS), imgsz=imgsz,
                            verbose=False, classes=[cls])
        for path, r in zip(chunk, res):
            w, h = Image.open(path).size
            gt = [b for k, b in load_gt(labels_dir / f"{path.stem}.txt", w, h) if k == cls]
            n_gt += len(gt)
            for g in gt:
                n_gt_bin[bin_of(g)] += 1
            scored = sorted(((tuple(float(v) for v in b), float(c))
                             for b, c in zip(r.boxes.xyxy, r.boxes.conf)),
                            key=lambda t: -t[1])
            for c in CONFS:
                taken = set()
                for b, sc in scored:
                    if sc < c:
                        break
                    j, best = -1, 0.5
                    for k, g in enumerate(gt):
                        if k in taken:
                            continue
                        v = iou(g, b)
                        if v >= best:
                            j, best = k, v
                    if j >= 0:
                        taken.add(j)
                        tp[c] += 1
                        tp_bin[(c, bin_of(gt[j]))] += 1
                    else:
                        fp[c] += 1
    return {"tp": tp, "fp": fp, "tp_bin": tp_bin,
            "n_gt": n_gt, "n_gt_bin": n_gt_bin, "n_img": len(images)}


def recall_at_budget(m: dict, budget: float) -> tuple[float, float]:
    """FP/frame 이 예산 이하인 conf 중 회수율이 가장 높은 것. (recall, conf)."""
    ok = [c for c in CONFS if m["fp"][c] / m["n_img"] <= budget]
    if not ok:
        return 0.0, float("nan")
    c = min(ok, key=lambda c: c)   # 예산 안에서 가장 낮은 conf 가 회수율 최대
    return m["tp"][c] / max(1, m["n_gt"]), c


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("root", type=pathlib.Path)
    ap.add_argument("--sizes", type=int, nargs="+", default=[640, 960])
    ap.add_argument("--bin-budget", type=float, default=1.0,
                    help="구간별 분해를 볼 FP/frame 예산")
    args = ap.parse_args()

    from ultralytics import YOLO

    print(f"해상도 민감도 — 같은 FP/frame 예산에서 guardrail 회수율 비교")
    print(f"가중치는 전부 imgsz 640 학습. 960 은 추론만 올린 것이다.\n")

    agg = {s: collections.Counter() for s in args.sizes}
    for fold_dir in sorted(args.root.glob("fold*")):
        weights = args.root / "runs" / fold_dir.name / "weights" / "best.pt"
        if not (fold_dir / "images" / "test").is_dir() or not weights.exists():
            continue
        site = sorted({s.split("_")[1] for s, v in json.loads(
            (fold_dir / "split.json").read_text(encoding="utf-8"))["assignment"].items()
            if v == "test"})[0]
        imgs = sorted((fold_dir / "images" / "test").glob("*.jpg"))
        model = YOLO(str(weights))
        got = {s: measure(model, imgs, fold_dir / "labels" / "test", s)
               for s in args.sizes}

        print(f"  {fold_dir.name} / {site}  (프레임 {len(imgs)}, 정답 {got[args.sizes[0]]['n_gt']})")
        print(f"    {'FP/frame 예산':<14}" + "".join(f"{'imgsz ' + str(s):>13}" for s in args.sizes)
              + f"{'차이':>9}")
        for b in BUDGETS:
            vals = [recall_at_budget(got[s], b)[0] for s in args.sizes]
            print(f"    {b:<14.2f}" + "".join(f"{v:>13.3f}" for v in vals)
                  + f"{vals[-1] - vals[0]:>+9.3f}")
            for s, v in zip(args.sizes, vals):
                agg[s][b] += v

        # 구간별 분해
        print(f"    -- 최소 변(px) 구간별 회수율 @ FP/frame {args.bin_budget} --")
        confs = {s: recall_at_budget(got[s], args.bin_budget)[1] for s in args.sizes}
        for i, (lo, hi) in enumerate(BINS):
            label = f"{lo}~{hi if hi < 10**9 else ''}"
            n = got[args.sizes[0]]["n_gt_bin"][i]
            if not n:
                continue
            vals = [got[s]["tp_bin"][(confs[s], i)] / n for s in args.sizes]
            print(f"    {label:<10}(n={n:>5}) " + "".join(f"{v:>13.3f}" for v in vals)
                  + f"{vals[-1] - vals[0]:>+9.3f}")
        print()

    n_folds = sum(1 for _ in args.root.glob("fold*/split.json"))
    print(f"=== {n_folds}폴드 평균 회수율 ===")
    print(f"{'FP/frame 예산':<14}" + "".join(f"{'imgsz ' + str(s):>13}" for s in args.sizes)
          + f"{'차이':>9}")
    for b in BUDGETS:
        vals = [agg[s][b] / n_folds for s in args.sizes]
        print(f"{b:<14.2f}" + "".join(f"{v:>13.3f}" for v in vals)
              + f"{vals[-1] - vals[0]:>+9.3f}")
    print("\n  960 이 이기면 해상도가 제약이라는 강한 근거다(학습 스케일이 불리한데도 이긴 것).")
    print("  960 이 지면 근거가 약하다 — 학습/추론 스케일 불일치 탓일 수 있다.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

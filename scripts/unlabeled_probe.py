"""정답에 없는데 모델이 확신하는 난간을 뽑아 본다 — 라벨 누락 가설 검증.

육안으로 5개 프레임을 확인했더니, 라벨이 "화면의 모든 난간" 이 아니라 "작업자가
있는 작업 구역 주변의 칸" 에만 붙어 있었다. 사실이면 두 가지가 흔들린다.

  1. `targets.yaml` 의 `negative_ratio: 0.0` 은 **프레임 단위** 방어다. positive
     프레임 안의 미라벨 난간은 막지 못한다. YOLO 는 박스 밖을 배경으로 학습하므로
     그것이 "난간은 배경" 신호가 되고, 회수율을 직접 누른다 (train_results 1.2).
  2. A04 의 낮은 정밀도(0.16~0.24)를 도메인 시프트로 읽었는데, 미라벨 난간이
     많으면 그 FP 중 일부는 **맞았는데 정답이 없어서 틀렸다고 세어진 것**이다.

각 폴드는 자기 test 현장을 안 본 모델로 잰다 (leave-one-site-out). 즉 여기서
나오는 미매칭 예측은 "그 현장을 외워서 낸 것" 이 아니다.

IoU 임계를 0.1 로 둔다 — 0.5 를 쓰면 칸 경계가 밀린 정상 검출까지 섞여 들어와
"라벨이 없다" 와 "칸을 잘못 나눴다" 가 구분되지 않는다 (train_results 1.2 에서
경계 가설은 이미 기각됐다).

**이 스크립트는 판정하지 않는다.** 후보를 뽑아 사람이 보게 할 뿐이다.

    python scripts/unlabeled_probe.py D:/yolo/guardrail --out outputs/unlabeled
"""

from __future__ import annotations

import argparse
import json
import pathlib
import random
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from instance_probe import iou, load_gt  # noqa: E402


def site_of(fold_dir: pathlib.Path) -> str:
    assign = json.loads((fold_dir / "split.json").read_text(encoding="utf-8"))["assignment"]
    return sorted({s.split("_")[1] for s, v in assign.items() if v == "test"})[0]


def tile(images: list, cols: int, pad: int = 4, box: tuple | None = None):
    """격자로 붙인다. box 를 주면 비율을 유지한 채 그 크기 안에 레터박스한다.

    세로로 긴 crop 하나가 행 전체 높이를 밀어 올리는 것을 막는다.
    """
    from PIL import Image
    if not images:
        return None
    if box:
        bw, bh = box
        scaled = []
        for im in images:
            r = min(bw / im.width, bh / im.height)
            s = im.resize((max(1, int(im.width * r)), max(1, int(im.height * r))))
            cv = Image.new("RGB", box, (18, 18, 18))
            cv.paste(s, ((bw - s.width) // 2, (bh - s.height) // 2))
            scaled.append(cv)
        images = scaled
    w = max(im.width for im in images)
    scaled = [im.resize((w, int(im.height * w / im.width))) for im in images]
    rows = [scaled[i:i + cols] for i in range(0, len(scaled), cols)]
    hs = [max(im.height for im in r) for r in rows]
    cv = Image.new("RGB", (cols * w + (cols + 1) * pad,
                           sum(hs) + (len(rows) + 1) * pad), (18, 18, 18))
    y = pad
    for r, h in zip(rows, hs):
        x = pad
        for im in r:
            cv.paste(im, (x, y))
            x += w + pad
        y += h + pad
    return cv


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("root", type=pathlib.Path)
    ap.add_argument("--out", type=pathlib.Path, default=pathlib.Path("outputs/unlabeled"))
    ap.add_argument("--conf", type=float, default=0.25,
                    help="운용 임계. 낮추면 후보가 늘지만 쓰레기도 는다")
    ap.add_argument("--iou", type=float, default=0.1,
                    help="이 값 미만이면 '정답에 대응물이 전혀 없다' 로 본다")
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--crops", type=int, default=12, help="현장당 저장할 crop 수")
    ap.add_argument("--frames", type=int, default=4, help="현장당 저장할 전체 프레임 수")
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    from PIL import Image, ImageDraw
    from ultralytics import YOLO

    args.out.mkdir(parents=True, exist_ok=True)
    rng = random.Random(args.seed)

    print(f"conf {args.conf} / 미매칭 기준 IoU < {args.iou} / imgsz {args.imgsz}")
    print()
    print(f"{'fold':<7}{'현장':<6}{'프레임':>7}{'정답':>7}{'예측':>7}"
          f"{'미매칭':>8}{'미매칭/f':>10}{'예측중 비율':>12}")

    summary = {}
    for fold_dir in sorted(args.root.glob("fold*")):
        weights = args.root / "runs" / fold_dir.name / "weights" / "best.pt"
        if not (fold_dir / "images" / "test").is_dir() or not weights.exists():
            continue
        site = site_of(fold_dir)
        imgs = sorted((fold_dir / "images" / "test").glob("*.jpg"))
        model = YOLO(str(weights))

        n_gt = n_pred = 0
        found = []  # (path, box, conf, gt)
        for i in range(0, len(imgs), 16):
            chunk = imgs[i:i + 16]
            res = model.predict([str(p) for p in chunk], conf=args.conf,
                                imgsz=args.imgsz, verbose=False, classes=[0])
            for path, r in zip(chunk, res):
                w, h = Image.open(path).size
                gt = load_gt(fold_dir / "labels" / "test" / f"{path.stem}.txt", w, h)
                n_gt += len(gt)
                for b, c in zip(r.boxes.xyxy, r.boxes.conf):
                    box = tuple(float(v) for v in b)
                    n_pred += 1
                    if max((iou(g, box) for g in gt), default=0.0) < args.iou:
                        found.append((path, box, float(c), gt))

        n = len(imgs)
        print(f"{fold_dir.name:<7}{site:<6}{n:>7}{n_gt:>7}{n_pred:>7}"
              f"{len(found):>8}{len(found) / n:>10.2f}"
              f"{len(found) / max(1, n_pred):>12.1%}")
        summary[site] = {"frames": n, "gt": n_gt, "pred": n_pred, "unmatched": len(found)}

        if not found:
            continue

        # 1. crop — 이게 진짜 난간인지 보는 것이 목적이다
        picks = rng.sample(found, min(args.crops, len(found)))
        crops = []
        for path, (x1, y1, x2, y2), c, _ in sorted(picks, key=lambda t: -t[2]):
            im = Image.open(path).convert("RGB")
            mx, my = (x2 - x1) * 0.25, (y2 - y1) * 0.25
            cr = im.crop((max(0, x1 - mx), max(0, y1 - my),
                          min(im.width, x2 + mx), min(im.height, y2 + my)))
            cr = cr.resize((420, max(1, int(cr.height * 420 / cr.width))))
            d = ImageDraw.Draw(cr)
            d.rectangle([mx * 420 / (x2 - x1 + 2 * mx), my * 420 / (x2 - x1 + 2 * mx),
                         cr.width - mx * 420 / (x2 - x1 + 2 * mx),
                         cr.height - my * 420 / (x2 - x1 + 2 * mx)],
                        outline=(255, 215, 0), width=3)
            d.text((6, 4), f"conf {c:.2f}", fill=(255, 215, 0))
            crops.append(cr)
        g = tile(crops, 4, box=(420, 320))
        if g:
            g.save(args.out / f"{site}_crops.jpg", quality=88)

        # 2. 전체 프레임 — 빨강 정답 / 노랑 미매칭. 맥락을 봐야 판단이 된다
        byframe = {}
        for path, box, c, gt in found:
            byframe.setdefault(path, (gt, []))[1].append((box, c))
        sel = rng.sample(list(byframe), min(args.frames, len(byframe)))
        fulls = []
        for path in sel:
            gt, preds = byframe[path]
            im = Image.open(path).convert("RGB")
            d = ImageDraw.Draw(im)
            for b in gt:
                d.rectangle(list(b), outline=(255, 50, 50), width=5)
            for b, c in preds:
                d.rectangle(list(b), outline=(255, 215, 0), width=5)
                d.text((b[0] + 6, b[1] + 6), f"{c:.2f}", fill=(255, 215, 0))
            fulls.append(im.resize((760, int(im.height * 760 / im.width))))
        g = tile(fulls, 1)
        if g:
            g.save(args.out / f"{site}_frames.jpg", quality=87)

    (args.out / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\n저장: {args.out}")
    print("  *_crops.jpg  미매칭 예측 crop (노란 테두리가 예측 박스)")
    print("  *_frames.jpg 빨강=정답 / 노랑=미매칭 예측")
    print("\n  crop 이 실제 난간이면 라벨 누락이고, 아니면 진짜 오검출이다. 눈으로 볼 것.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

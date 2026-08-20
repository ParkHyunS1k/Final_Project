"""사전학습 PPE 모델(YOLOv8s, 10-class)로 건설현장 이미지 배치 추론.

usage:
    python detect.py <이미지_디렉터리> [--out 결과폴더] [--conf 0.25] [--limit N]
"""

import argparse
import collections
import pathlib
import sys

from ultralytics import YOLO

ROOT = pathlib.Path(__file__).parent
WEIGHTS = ROOT / "weights" / "ppe_yolov8s_voxdroid.pt"
IMG_EXT = {".jpg", ".jpeg", ".png", ".bmp"}


def collect_images(src: pathlib.Path, limit: int | None) -> list[pathlib.Path]:
    imgs = sorted(p for p in src.rglob("*") if p.suffix.lower() in IMG_EXT)
    return imgs[:limit] if limit else imgs


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("src", type=pathlib.Path)
    ap.add_argument("--out", type=pathlib.Path, default=ROOT / "runs")
    ap.add_argument("--conf", type=float, default=0.25)
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--device", default="mps")
    args = ap.parse_args()
    args.out = args.out.resolve()  # 상대경로면 ultralytics runs_dir 밑에 중첩됨

    imgs = collect_images(args.src, args.limit)
    if not imgs:
        print(f"이미지 없음: {args.src}")
        return 1
    print(f"이미지 {len(imgs)}장 | conf={args.conf} | device={args.device}")

    model = YOLO(str(WEIGHTS))
    names = model.names

    counts = collections.Counter()
    per_image = []
    empty = 0

    for i in range(0, len(imgs), 16):
        batch = imgs[i : i + 16]
        results = model.predict(
            [str(p) for p in batch],
            conf=args.conf,
            device=args.device,
            save=True,
            project=str(args.out),
            name="predict",
            exist_ok=True,
            verbose=False,
        )
        for path, r in zip(batch, results):
            cls = collections.Counter(names[int(c)] for c in r.boxes.cls)
            counts.update(cls)
            if not cls:
                empty += 1
            per_image.append((path, cls, r.boxes.conf))

    print(f"\n--- 클래스별 검출 수 ({len(imgs)}장) ---")
    for name, n in counts.most_common():
        print(f"  {name:<16} {n}")
    print(f"\n미검출 이미지: {empty}/{len(imgs)} ({empty / len(imgs):.1%})")
    print(f"시각화 결과: {args.out / 'predict'}")

    print("\n--- 샘플 10장 상세 ---")
    for path, cls, conf in per_image[:10]:
        detail = ", ".join(f"{k}×{v}" for k, v in cls.items()) or "(검출 없음)"
        mean = f" | avg_conf={float(conf.mean()):.2f}" if len(conf) else ""
        print(f"  {path.name}: {detail}{mean}")

    return 0


if __name__ == "__main__":
    sys.exit(main())

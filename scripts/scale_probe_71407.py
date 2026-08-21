"""71407 A26 실패가 스케일 때문인지 가리는 추론 전용 실험.

A26 의 난간은 화면 면적의 45~77% 를 차지한다. 507 학습 데이터의 난간은 5.8% 다.
`scale` 증강을 올리기 전에 **정말 스케일이 원인인지** 먼저 확인해야 한다.
원인이 구조·배경이면 증강을 키워도 해결되지 않는다.

방법: A26 이미지를 s 배로 축소해 원본 크기의 회색 캔버스 가운데 붙이고(letterbox
패딩과 같은 114 회색) 정답 박스도 같은 변환을 먹인다. 화면 대비 난간 면적은
s^2 배가 된다. 학습 분포(0.058)에 가까워질 때 AP 가 회복되면 스케일 가설이 지지된다.

    python scripts/scale_probe_71407.py --src D:/yolo/eval71407 --out D:/yolo/scaleprobe
    yolo val model=... data=D:/yolo/scaleprobe/s036/data.yaml classes=0

이미지 내용은 그대로 두고 크기만 바꾸므로, AP 변화는 스케일 요인만 반영한다.
"""

from __future__ import annotations

import argparse
import pathlib

import yaml
from PIL import Image

PAD = (114, 114, 114)   # Ultralytics letterbox 와 같은 회색
NAMES = {0: "guardrail", 1: "work_platform", 2: "worker"}


def rescale(img: Image.Image, boxes: list[tuple[float, ...]], s: float):
    """이미지를 s 배로 축소해 같은 크기 캔버스 가운데 붙이고 박스도 옮긴다."""
    W, H = img.size
    nw, nh = max(1, round(W * s)), max(1, round(H * s))
    canvas = Image.new("RGB", (W, H), PAD)
    ox, oy = (W - nw) // 2, (H - nh) // 2
    canvas.paste(img.resize((nw, nh), Image.LANCZOS), (ox, oy))

    out = []
    for cls, cx, cy, bw, bh in boxes:
        out.append((cls,
                    (cx * nw + ox) / W, (cy * nh + oy) / H,
                    bw * nw / W, bh * nh / H))
    return canvas, out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", type=pathlib.Path, default=pathlib.Path("D:/yolo/eval71407"))
    ap.add_argument("--out", type=pathlib.Path, default=pathlib.Path("D:/yolo/scaleprobe"))
    ap.add_argument("--site", default="A26")
    ap.add_argument("--scales", type=float, nargs="+", default=[0.60, 0.36, 0.25])
    args = ap.parse_args()

    listing = args.src / f"site_{args.site}.txt"
    if not listing.exists():
        raise SystemExit(f"없는 파일: {listing}\n  scripts/build_eval_71407.py 를 먼저 실행하세요.")
    paths = [pathlib.Path(x) for x in listing.read_text(encoding="utf-8").splitlines() if x]

    for s in args.scales:
        tag = f"s{int(round(s * 100)):03d}"
        dst = args.out / tag
        img_dir, lab_dir = dst / "images/val", dst / "labels/val"
        for d in (img_dir, lab_dir):
            d.mkdir(parents=True, exist_ok=True)

        n = 0
        for p in paths:
            lab = args.src / "labels/val" / f"{p.stem}.txt"
            boxes = [tuple(float(v) for v in line.split())
                     for line in lab.read_text().splitlines() if line.strip()]
            canvas, moved = rescale(Image.open(p).convert("RGB"), boxes, s)
            canvas.save(img_dir / p.name, quality=92)
            (lab_dir / f"{p.stem}.txt").write_text("\n".join(
                f"{int(c)} {cx:.6f} {cy:.6f} {bw:.6f} {bh:.6f}" for c, cx, cy, bw, bh in moved))
            n += 1

        (dst / "data.yaml").write_text(yaml.safe_dump(
            {"path": str(dst.resolve()), "train": "images/val", "val": "images/val",
             "names": NAMES}, allow_unicode=True, sort_keys=False), encoding="utf-8")
        print(f"{tag}: {n}장  면적 x{s * s:.3f}  -> {dst / 'data.yaml'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

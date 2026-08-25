"""구역 crop 을 층화 표집해 저장한다 — 눈으로 보기 위한 것이다.

`README.md` 10절 순서 1. VLM 파일럿과 4요소 라벨링에 착수하기 전에 물어야 하는
것은 **`SO-01` 크롭에서 법령 4요소가 애초에 육안으로 구분되는가**이다.
상부 난간대 / 중간 난간대 / 발끝막이판 / 난간기둥 중 발끝막이판은 면적대
0.10~0.20 구역(1920x1080 기준 약 600x350px)에서 세로 30px 안팎이다.
**사람이 못 보면 어떤 VLM 도 못 보고 라벨러도 못 단다.**

표집은 랜덤이 아니라 **현장 x 정상/미설치 x 클립 x 면적대**로 층화한다
(`docs/eval_protocol.md` 3.7). 클립을 섞지 않으면 같은 장면만 보게 된다.

crop 은 원본 해상도로 자른 뒤 확대한다. 축소하면 판정 가능성을 과대평가한다.

    python scripts/zone_crops.py --out outputs/zone_crops
"""

from __future__ import annotations

import argparse
import collections
import json
import pathlib
import random
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from zone_eval import collect_zones  # noqa: E402

BANDS = ((0.00, 0.05), (0.05, 0.10), (0.10, 0.20), (0.20, 1.01))


def sheet(cells, cols, cw, ch):
    """레터박스 격자. 세로로 긴 crop 하나가 행 높이를 밀어 올리는 것을 막는다."""
    from PIL import Image, ImageDraw
    rows = (len(cells) + cols - 1) // cols
    cv = Image.new("RGB", (cols * (cw + 6) + 6, rows * (ch + 26) + 6), (18, 18, 18))
    d = ImageDraw.Draw(cv)
    for i, (im, cap) in enumerate(cells):
        r = min(cw / im.width, ch / im.height)
        s = im.resize((max(1, int(im.width * r)), max(1, int(im.height * r))))
        x = 6 + (i % cols) * (cw + 6)
        y = 6 + (i // cols) * (ch + 26)
        cv.paste(s, (x + (cw - s.width) // 2, y + (ch - s.height) // 2))
        d.text((x + 2, y + ch + 6), cap, fill=(230, 200, 90))
    return cv


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=pathlib.Path, default=pathlib.Path("outputs/zone_crops"))
    ap.add_argument("--per-cell", type=int, default=3, help="면적대당 클립 수")
    ap.add_argument("--context", type=float, default=0.6,
                    help="문맥 crop 여백 배율. 0 이면 tight crop 만")
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    from PIL import Image

    args.out.mkdir(parents=True, exist_ok=True)
    rng = random.Random(args.seed)
    zones = collect_zones()

    print(f"{'현장':<6}{'종류':<6}{'면적대':<14}{'클립':>6}{'구역':>8}{'중앙 px':>12}")
    meta = []
    for site in sorted(zones):
        for kind in ("pos", "neg"):
            picks = []
            for lo, hi in BANDS:
                byclip = collections.defaultdict(list)
                for img, box, clip in zones[site][kind]:
                    w, h = Image.open(img).size
                    ar = (box[2] - box[0]) * (box[3] - box[1]) / (w * h)
                    if lo <= ar < hi:
                        byclip[clip].append((img, box, ar))
                if not byclip:
                    continue
                px = sorted(int(b[2] - b[0]) for v in byclip.values() for _, b, _ in v)
                n = sum(len(v) for v in byclip.values())
                print(f"{site:<6}{kind:<6}{f'{lo:.2f}~{hi:.2f}':<14}"
                      f"{len(byclip):>6}{n:>8}{px[len(px) // 2]:>12}")
                for clip in rng.sample(sorted(byclip), min(args.per_cell, len(byclip))):
                    picks.append((f"{lo:.2f}", clip, *rng.choice(byclip[clip])))

            cells = []
            for band, clip, img, box, ar in picks:
                im = Image.open(img).convert("RGB")
                x1, y1, x2, y2 = box
                m = max(x2 - x1, y2 - y1) * args.context
                cr = im.crop((max(0, x1 - m), max(0, y1 - m),
                              min(im.width, x2 + m), min(im.height, y2 + m)))
                cells.append((cr, f"{band} ar{ar:.3f} {int(x2 - x1)}x{int(y2 - y1)}px"))
                meta.append({"site": site, "kind": kind, "band": band, "clip": clip,
                             "frame": img.name, "area_ratio": round(ar, 4),
                             "px": [int(x2 - x1), int(y2 - y1)]})
            if cells:
                sheet(cells, 3, 620, 460).save(
                    args.out / f"{site}_{kind}.jpg", quality=93)

    (args.out / "meta.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\n저장: {args.out}  (pos=SO-01 정상 / neg=UC-01 미설치)")
    print("  물어야 할 것: 상부 난간대·중간 난간대·발끝막이판·난간기둥이 구분되는가")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

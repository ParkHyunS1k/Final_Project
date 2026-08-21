"""난간이 없는 장면에서의 오검출률을 잰다.

현재 guardrail 데이터셋은 `SO-01` 이 있는 프레임만 남기고(`targets.yaml` 의
`require`), 외부 검증셋도 마찬가지다. 그래서 AP 는 **"난간이 있는 화면에서 찾는
능력"** 만 잰다. 제품이 요구하는 것은 미설치 판정이므로 난간이 없는 장면에서
얼마나 잘못 짖는지도 재야 한다.

71407 `N-04`(개구부 안전난간 불량)를 negative 로 쓴다. 프레임을 눈으로 확인했다 —
덮개도 난간도 없는 개구부 단독 장면이고 작업자·비계가 없다.

    python scripts/fp_probe.py --model D:/yolo/guardrail/runs/fold0/weights/best.pt \
        --zip "D:/71407/source_val/.../VS_5대사고유형_추락_비정상_N-04.zip"

원천을 풀지 않고 zip 에서 바로 읽는다. 정답이 전무한 집합이라 mAP 는 정의되지
않으므로 **검출이 하나라도 난 프레임의 비율**과 신뢰도 분포를 본다.
"""

from __future__ import annotations

import argparse
import io
import pathlib
import statistics
import zipfile
from typing import Iterator

from PIL import Image


def images(zips: list[pathlib.Path], dirs: list[pathlib.Path]) -> Iterator[tuple[str, Image.Image]]:
    for z in zips:
        with zipfile.ZipFile(z) as zf:
            for name in sorted(x for x in zf.namelist() if x.lower().endswith(".jpg")):
                yield name, Image.open(io.BytesIO(zf.read(name))).convert("RGB")
    for d in dirs:
        for p in sorted(d.rglob("*.jpg")):
            yield p.name, Image.open(p).convert("RGB")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True, type=pathlib.Path)
    ap.add_argument("--zip", dest="zips", action="append", type=pathlib.Path, default=[])
    ap.add_argument("--dir", dest="dirs", action="append", type=pathlib.Path, default=[])
    ap.add_argument("--class-id", type=int, default=0)
    ap.add_argument("--conf", type=float, nargs="+", default=[0.25, 0.5])
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--batch", type=int, default=16)
    args = ap.parse_args()

    if not args.zips and not args.dirs:
        raise SystemExit("--zip 또는 --dir 를 하나 이상 주세요.")

    from ultralytics import YOLO
    model = YOLO(str(args.model))

    # 최저 임계값으로 한 번만 추론하고 나머지는 신뢰도로 걸러 센다
    lo = min(args.conf)
    confs: list[list[float]] = []
    batch: list[Image.Image] = []

    def flush() -> None:
        if not batch:
            return
        for r in model.predict(batch, conf=lo, imgsz=args.imgsz, verbose=False):
            confs.append([float(c) for c, k in zip(r.boxes.conf, r.boxes.cls)
                          if int(k) == args.class_id])
        batch.clear()

    for _, im in images(args.zips, args.dirs):
        batch.append(im)
        if len(batch) >= args.batch:
            flush()
    flush()

    n = len(confs)
    if not n:
        raise SystemExit("이미지를 하나도 읽지 못했습니다. 경로를 확인하세요.")

    print(f"모델 {args.model}")
    print(f"이미지 {n}장 / 클래스 {args.class_id} 오검출 (정답 없음)")
    print(f"{'conf':>8}{'검출된 프레임':>16}{'비율':>10}{'검출/프레임':>14}")
    for c in sorted(args.conf):
        hit = [x for x in confs if any(v >= c for v in x)]
        total = sum(1 for x in confs for v in x if v >= c)
        print(f"{c:>8.2f}{len(hit):>16}{len(hit) / n:>10.1%}{total / n:>14.3f}")

    flat = [v for x in confs for v in x]
    if flat:
        flat.sort()
        print(f"\n신뢰도 중앙값 {statistics.median(flat):.3f} / "
              f"90분위 {flat[int(len(flat) * 0.9)]:.3f} / 최대 {flat[-1]:.3f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

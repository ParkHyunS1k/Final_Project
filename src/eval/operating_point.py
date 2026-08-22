"""운용 임계(conf) 를 val 에서 고르고 test 에서 재는 도구.

**왜 필요한가.** AP 는 PR 곡선을 conf≈0 까지 적분한 값이라 "실제로 어느 임계로
돌릴 것인가" 를 말해 주지 않는다. guardrail 은 그 차이가 치명적이었다 —
AP@0.5 가 0.42 인 폴드가 conf 0.25 에서는 프레임당 0.00개를 검출했고, 네 폴드
전부 F1 이 conf 에 대해 단조 감소했다 (`docs/train_results.md` 1.2절).
즉 쓰고 있던 0.25 는 운용점이 아니었다.

**왜 val 인가.** test 현장으로 conf 를 고르면 그 현장에 맞춘 값이 되어 "안 본
현장에서 되는가" 라는 질문이 무너진다. val 은 train 현장에서 뗀 것이라
(`split.carve_val`) 낙관적이지만, 적어도 test 현장을 보지 않는다.

매칭은 신뢰도 순 탐욕이다 — 정답 하나당 예측 하나, IoU >= 0.5. Ultralytics 의
AP 계산과 같은 규칙이고, 8.4.123 은 F1 곡선을 결과 객체로 내주지 않아 직접 센다.
"""

from __future__ import annotations

import pathlib

CONFS = (0.01, 0.02, 0.03, 0.05, 0.07, 0.10, 0.15, 0.20,
         0.25, 0.30, 0.35, 0.40, 0.50, 0.60, 0.70)


def iou(a, b) -> float:
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    ix = max(0.0, min(ax2, bx2) - max(ax1, bx1))
    iy = max(0.0, min(ay2, by2) - max(ay1, by1))
    inter = ix * iy
    ua = (ax2 - ax1) * (ay2 - ay1) + (bx2 - bx1) * (by2 - by1) - inter
    return inter / ua if ua > 0 else 0.0


def load_gt(path: pathlib.Path, w: int, h: int) -> list[tuple[int, tuple]]:
    """YOLO 라벨 파일 -> [(class_id, (x1, y1, x2, y2))]."""
    if not path.exists():
        return []
    out = []
    for line in path.read_text().splitlines():
        p = line.split()
        if len(p) < 5:
            continue
        cx, cy, bw, bh = (float(v) for v in p[1:5])
        out.append((int(p[0]), ((cx - bw / 2) * w, (cy - bh / 2) * h,
                                (cx + bw / 2) * w, (cy + bh / 2) * h)))
    return out


def count(model, images: list[pathlib.Path], labels: pathlib.Path, n_cls: int,
          confs=CONFS, iou_thr: float = 0.5, batch: int = 16) -> dict:
    """conf x 클래스별 (tp, fp) 와 클래스별 정답 수를 센다."""
    from PIL import Image

    tp = {(c, k): 0 for c in confs for k in range(n_cls)}
    fp = {(c, k): 0 for c in confs for k in range(n_cls)}
    n_gt = {k: 0 for k in range(n_cls)}

    for i in range(0, len(images), batch):
        chunk = images[i:i + batch]
        res = model.predict([str(p) for p in chunk], conf=min(confs), imgsz=640,
                            verbose=False)
        for path, r in zip(chunk, res):
            w, h = Image.open(path).size
            gt = load_gt(labels / f"{path.stem}.txt", w, h)
            for k, _ in gt:
                if k < n_cls:
                    n_gt[k] += 1
            scored = sorted(
                ((int(c), tuple(float(v) for v in b), float(s))
                 for b, c, s in zip(r.boxes.xyxy, r.boxes.cls, r.boxes.conf)),
                key=lambda t: -t[2])
            for c in confs:
                taken = set()
                for k, b, s in scored:
                    if s < c:
                        break
                    if k >= n_cls:
                        continue
                    j, best = -1, iou_thr
                    for idx, (gk, g) in enumerate(gt):
                        if gk != k or idx in taken:
                            continue
                        v = iou(g, b)
                        if v >= best:
                            j, best = idx, v
                    if j >= 0:
                        taken.add(j)
                        tp[(c, k)] += 1
                    else:
                        fp[(c, k)] += 1
    return {"tp": tp, "fp": fp, "n_gt": n_gt, "confs": tuple(confs)}


def prf(counts: dict, conf: float, k: int) -> tuple[float, float, float]:
    tp, fp = counts["tp"][(conf, k)], counts["fp"][(conf, k)]
    p = tp / (tp + fp) if tp + fp else 0.0
    r = tp / counts["n_gt"][k] if counts["n_gt"][k] else 0.0
    return p, r, (2 * p * r / (p + r) if p + r else 0.0)


def select(counts: dict, k: int) -> float:
    """F1 을 최대화하는 conf. 동점이면 높은 쪽(보수적인 쪽)을 고른다."""
    return max(counts["confs"], key=lambda c: (prf(counts, c, k)[2], c))

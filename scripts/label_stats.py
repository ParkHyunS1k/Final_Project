"""Phase 0 산출물 — 라벨만으로 뽑는 통계.

원천 데이터(450GB) 없이 라벨(711MB)만으로 다음을 확정한다.

  1. 작업유형 x 클래스 인스턴스 교차표
     -> 어느 원천 zip을 받아야 하는지 결정
  2. 클래스별 박스 크기 분포
     -> UA-01(안전고리 미체결) 박스가 작업자 전신인지 고리 영역인지 판정.
        docs/data_plan.md 2절의 최대 리스크
  3. WO-06 과 UA-01 좌표 중복률
     -> README 13절 "WO와 UA는 동일 인스턴스" 검증
  4. 영상 단위 개수
     -> 영상 단위 분할이 성립하는지 확인

usage:
    python scripts/label_stats.py <라벨_루트> [--out outputs/label_stats]
"""

from __future__ import annotations

import argparse
import collections
import json
import pathlib
import statistics
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from src.data.aihub import Frame, iter_frames  # noqa: E402

# 507 작업유형은 영상 ID의 process_ID 자리에서 온다: H-210717_E01_E_WS-20_201
PROCESS = {
    "A": "비계작업",
    "B": "사다리작업",
    "C": "로프작업",
    "D": "고소작업대작업",
    "E": "개구부작업",
    "F": "공통",
}


def work_type(f: Frame) -> str:
    if f.dataset != "507":
        return f.situation_id or "?"
    parts = f.video_id.split("_")
    return PROCESS.get(parts[2], f"?{parts[2] if len(parts) > 2 else ''}") if len(parts) > 2 else "?"


def iou(a, b) -> float:
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    ix = max(0.0, min(ax2, bx2) - max(ax1, bx1))
    iy = max(0.0, min(ay2, by2) - max(ay1, by1))
    inter = ix * iy
    ua = (ax2 - ax1) * (ay2 - ay1) + (bx2 - bx1) * (by2 - by1) - inter
    return inter / ua if ua > 0 else 0.0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("root", type=pathlib.Path)
    ap.add_argument("--out", type=pathlib.Path, default=pathlib.Path("outputs/label_stats"))
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    cross = collections.defaultdict(collections.Counter)  # 작업유형 -> 클래스 -> n
    areas = collections.defaultdict(list)  # 클래스 -> 정규화 면적
    videos = collections.defaultdict(set)  # 작업유형 -> 영상 ID
    per_frame = []  # (frame, {class: [bbox]}) — 중복률 계산용
    n_frames = 0

    for f in iter_frames(args.root):
        n_frames += 1
        wt = work_type(f)
        videos[wt].add(f.video_id)
        W, H = f.resolution
        byc = collections.defaultdict(list)
        for a in f.annotations:
            cross[wt][a.class_code] += 1
            if W and H:
                areas[a.class_code].append(a.area / (W * H))
            byc[a.class_code].append(a.bbox)
        per_frame.append(byc)

    if not n_frames:
        print(f"라벨 JSON 없음: {args.root}")
        return 1

    # ---- 1. 교차표
    classes = sorted({c for cnt in cross.values() for c in cnt})
    print(f"\n프레임 {n_frames} | 작업유형 {len(cross)} | 클래스 {len(classes)}\n")
    print("=== 작업유형 x 클래스 교차표 (상위 30클래스) ===")
    top = [c for c, _ in collections.Counter(
        {c: sum(cnt[c] for cnt in cross.values()) for c in classes}).most_common(30)]
    hdr = f"{'작업유형':<16}" + "".join(f"{c:>10}" for c in top[:12])
    print(hdr)
    for wt in sorted(cross):
        print(f"{wt:<16}" + "".join(f"{cross[wt][c]:>10}" for c in top[:12]))

    # ---- 2. 박스 크기 분포 — 안전고리 리스크 판정
    print("\n=== 박스 크기 분포 (이미지 대비 면적 비율) ===")
    print(f"{'클래스':<10}{'n':>8}{'중앙값':>10}{'p10':>10}{'p90':>10}")
    for c in top[:20]:
        v = sorted(areas.get(c, []))
        if not v:
            continue
        p = lambda q: v[min(len(v) - 1, int(len(v) * q))]  # noqa: E731
        print(f"{c:<10}{len(v):>8}{statistics.median(v):>10.4f}{p(0.1):>10.4f}{p(0.9):>10.4f}")

    if "WO-01" in areas and any(c in areas for c in ("UA-01", "WO-06")):
        w = statistics.median(areas["WO-01"])
        for c in ("UA-01", "WO-06"):
            if c in areas:
                r = statistics.median(areas[c]) / w if w else 0
                verdict = "작업자 전신 수준 → B안(사람 단위 상태 분류)" if r > 0.5 \
                    else "작업자보다 훨씬 작음 → A안(부품 탐지)"
                print(f"\n  {c} 중앙 면적 / WO-01 중앙 면적 = {r:.2f}  → {verdict}")

    # ---- 3. WO-06 vs UA-01 중복률
    pairs = [("WO-06", "UA-01"), ("UC-01", "UC-04"), ("UC-03", "UC-06")]
    print("\n=== 코드 쌍 중복률 (같은 프레임 내 IoU>0.5 매칭 비율) ===")
    present = {c for cnt in cross.values() for c in cnt}
    for a_code, b_code in pairs:
        missing = [c for c in (a_code, b_code) if c not in present]
        if missing:
            print(f"  {a_code} vs {b_code}: 판정 불가 — {', '.join(missing)} 이(가) 이 라벨셋에 없음")
            continue
        both = matched = total = 0
        for byc in per_frame:
            if a_code not in byc or b_code not in byc:
                continue
            both += 1
            for ba in byc[a_code]:
                total += 1
                if any(iou(ba, bb) > 0.5 for bb in byc[b_code]):
                    matched += 1
        if total:
            print(f"  {a_code} vs {b_code}: 공존 프레임 {both}, 매칭 {matched}/{total} "
                  f"({matched / total:.1%}) → {'동일 인스턴스' if matched / total > 0.8 else '별개'}")
        else:
            print(f"  {a_code} vs {b_code}: 둘 다 존재하나 같은 프레임에 공존하지 않음 "
                  f"→ 별개 (작업유형이 갈린 것)")

    # ---- 4. 영상 단위
    print("\n=== 영상 단위 (분할 키) ===")
    for wt in sorted(videos):
        n = len(videos[wt])
        print(f"  {wt:<16} 영상 {n:>5}개 | 프레임 {sum(cross[wt].values()):>8} 어노테이션")

    out = args.out / "cross_table.json"
    out.write_text(json.dumps(
        {"frames": n_frames,
         "cross": {k: dict(v) for k, v in cross.items()},
         "videos": {k: sorted(v) for k, v in videos.items()},
         "area_median": {c: statistics.median(v) for c, v in areas.items() if v}},
        ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n저장: {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

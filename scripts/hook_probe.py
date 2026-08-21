"""hook 모델이 "미체결" 을 배웠는지 "사람" 을 배웠는지 가리는 진단.

507 공통 파티션에는 체결 상태 클래스가 없다. 미체결(`WO-06`/`UA-01`)만 라벨돼
있으므로, 모델이 상태를 구분하는 게 아니라 그냥 작업자를 찾고 있을 수 있다.

**1단계 (라벨만, 결정적)** — 같은 프레임 안에 "미체결로 표시된 작업자" 와
"표시되지 않은 작업자" 가 공존하는가. 공존하지 않고 라벨된 작업자가 전원
미체결이면, 데이터 안에 구분을 배울 근거가 아예 없다는 뜻이다.

**2단계 (모델, 보조)** — 공통 WS 프레임에 모델을 걸어 예측이 `WO-01` 작업자
박스와 얼마나 겹치는지 본다.

  주의: WS 에 `WO-06` 이 0건인 것은 "미체결 작업자가 없다" 가 아니라 "그 상황에서
  그 코드를 라벨하지 않았다" 는 뜻이다 (configs/data/targets.yaml 11행).
  따라서 WS 에서 검출이 난다고 곧바로 오검출이라 할 수 없다. 이 단계의 결론은
  **"예측이 사람 위치를 따라가는가"** 까지이며, 체결 여부 판별 능력은
  사람이 확인한 별도 평가셋 없이는 판정하지 않는다.

    python scripts/hook_probe.py --model D:/yolo/hook/runs/all_train/weights/best.pt
"""

from __future__ import annotations

import argparse
import collections
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from src.data.aihub import iter_frames  # noqa: E402

LABELS = pathlib.Path(r"D:\507\label_val\122.고소작업_현장_실시간_영상_데이터"
                      r"\01.데이터\2.Validation\라벨링데이터\공통")
SOURCE = pathlib.Path(r"D:\507\source_val\122.고소작업_현장_실시간_영상_데이터"
                      r"\01.데이터\2.Validation\원천데이터\공통")


def iou(a, b) -> float:
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    ix, iy = max(0.0, min(ax2, bx2) - max(ax1, bx1)), max(0.0, min(ay2, by2) - max(ay1, by1))
    inter = ix * iy
    ua = (ax2 - ax1) * (ay2 - ay1) + (bx2 - bx1) * (by2 - by1) - inter
    return inter / ua if ua > 0 else 0.0


def collect(situation: str) -> list:
    out = []
    for f in iter_frames(LABELS):
        parts = f.video_id.split("_")
        if len(parts) < 3 or parts[2] != "F":
            continue
        if not str(f.situation_id).startswith(situation):
            continue
        by = collections.defaultdict(list)
        for a in f.annotations:
            by[a.class_code].append(a.bbox)
        out.append((f, by))
    return out


def stage1() -> None:
    for situ in ("UA", "WS"):
        frames = collect(situ)
        if not frames:
            print(f"\n=== 공통 {situ}: 프레임 없음")
            continue
        n = len(frames)
        cnt = collections.Counter()
        pairs = collections.Counter()
        unmatched_workers = 0
        for _, by in frames:
            for code in ("WO-01", "UA-01", "WO-06"):
                cnt[code] += len(by.get(code, []))
            w, u = by.get("WO-01", []), by.get("UA-01", [])
            pairs[(len(w), len(u))] += 1
            for wb in w:
                if not any(iou(wb, ub) > 0.5 for ub in u):
                    unmatched_workers += 1
        print(f"\n=== 공통 {situ} — 프레임 {n}")
        for code in ("WO-01", "UA-01", "WO-06"):
            print(f"  {code:<8}{cnt[code]:>8}  (프레임당 {cnt[code] / n:.2f})")
        print(f"  (WO-01, UA-01) 조합 상위: {pairs.most_common(5)}")
        if cnt["WO-01"]:
            print(f"  UA-01 과 IoU>0.5 로 매칭 안 되는 작업자: "
                  f"{unmatched_workers} / {cnt['WO-01']} = "
                  f"{unmatched_workers / cnt['WO-01']:.1%}")
            print("   -> 0% 에 가까우면 라벨된 작업자가 전원 미체결이라는 뜻이고, "
                  "데이터 안에 체결/미체결을 가를 근거가 없다.")
        else:
            print("   -> 작업자 클래스(WO-01)가 이 파티션에 없다. 라벨만으로는 "
                  "'표시되지 않은 작업자' 의 존재를 알 수 없다 (2단계에서 사람 탐지로 센다).")

        # WO-06 이 있는 프레임과 없는 프레임의 클래스 구성을 비교한다.
        # 없는 쪽에 작업자가 있다면 그것이 대조군 후보다.
        if situ == "UA":
            with_t, without_t = collections.Counter(), collections.Counter()
            for _, by in frames:
                tgt = with_t if by.get("WO-06") else without_t
                for code, boxes in by.items():
                    tgt[code] += len(boxes)
            print(f"  WO-06 있는 프레임의 코드: {with_t.most_common(6)}")
            print(f"  WO-06 없는 프레임의 코드: {without_t.most_common(6)}")


def stage2(model_path: pathlib.Path, conf: float, limit: int) -> None:
    """공통에는 WO-01 이 없으므로 COCO 사전학습 모델의 person 으로 작업자를 센다.

    묻는 것은 두 가지다.
      (1) WO-06 이 붙은 프레임에 사람이 몇 명인가. 1명뿐이면 "라벨된 작업자 = 전원
          미체결" 이므로 대조군이 없다.
      (2) WO-06 이 없는 UA 프레임에 사람이 있는가. 있다면 그들이 대조군 후보다.
          (상태는 라벨이 없어 모르므로 후보까지만 말할 수 있다.)
    그리고 hook 모델의 예측이 그 사람 위치를 따라가는지 본다.
    """
    index = {p.stem: p for p in SOURCE.rglob("*.jpg")}
    groups = {"WO-06 있음": [], "WO-06 없는 UA": []}
    for f, by in collect("UA"):
        if f.image_id not in index:
            continue
        groups["WO-06 있음" if by.get("WO-06") else "WO-06 없는 UA"].append((f, by))
    for k in groups:
        groups[k] = groups[k][:limit]

    from ultralytics import YOLO
    coco = YOLO(str(pathlib.Path(__file__).resolve().parents[1] / "yolo26s.pt"))
    hook = YOLO(str(model_path))

    for gname, frames in groups.items():
        if not frames:
            continue
        persons = 0
        per_frame = collections.Counter()
        dets = collections.Counter()
        on_person = collections.Counter()
        covered = 0
        for i in range(0, len(frames), 16):
            chunk = frames[i:i + 16]
            paths = [str(index[f.image_id]) for f, _ in chunk]
            pr = coco.predict(paths, conf=0.35, imgsz=640, verbose=False, classes=[0])
            hr = hook.predict(paths, conf=conf, imgsz=640, verbose=False)
            for (f, by), rp, rh in zip(chunk, pr, hr):
                boxes = [tuple(float(v) for v in b) for b in rp.boxes.xyxy]
                persons += len(boxes)
                per_frame[len(boxes)] += 1
                for pb in boxes:
                    if any(iou(pb, ub) > 0.3 for ub in by.get("UA-01", [])):
                        covered += 1
                for b, k in zip(rh.boxes.xyxy, rh.boxes.cls):
                    name = rh.names[int(k)]
                    dets[name] += 1
                    if any(iou(tuple(float(v) for v in b), pb) > 0.3 for pb in boxes):
                        on_person[name] += 1

        n = len(frames)
        print(f"\n=== 2단계 [{gname}] {n} 프레임")
        print(f"  COCO person {persons}명 (프레임당 {persons / n:.2f}) "
              f"인원수 분포 {dict(sorted(per_frame.items()))}")
        if persons:
            print(f"  UA-01 박스로 덮인 사람: {covered}/{persons} = {covered / persons:.1%}")
        for name, c in dets.most_common():
            print(f"  hook 예측 {name:<20}{c:>6}  사람과 겹침 {on_person[name] / c:.1%}"
                  f"  사람 대비 {c / max(1, persons):.2f}배")
    print("\n  -> 예측이 사람 위치를 따라가는지까지만 말할 수 있다. "
          "체결 여부 판별 능력은 상태를 사람이 확인한 평가셋 없이는 판정하지 않는다.")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", type=pathlib.Path)
    ap.add_argument("--conf", type=float, default=0.25)
    ap.add_argument("--limit", type=int, default=400)
    args = ap.parse_args()

    stage1()
    if args.model:
        stage2(args.model, args.conf, args.limit)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

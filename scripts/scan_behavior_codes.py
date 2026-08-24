"""507 상황·행동 라벨의 정체를 확정한다 — 이름만 보고 판단하지 않기 위해서.

`README.md` 2절 C그룹 3종의 코드(`UA-06/07/08`, `12/13/14`, `24/25/26`)는
저장소에서 README 73~75행에만 존재했다. `class_mapping.yaml` 에 등재된 507 코드는
SO-01/02/08/12/15, UA-01, UC-01/03/04/06, WO-01, WO-06 뿐이었다.
**한 번도 열어본 적이 없었다.**

이 프로젝트는 이름만 보고 라벨의 의미를 단정했다 두 번 틀렸다
(`HANDOFF.md` 6절 1번). `WO-06` 은 이름이 "안전고리 미착용" 인데 실제 박스는
작업자 몸통이었다.

**`src.data.aihub.iter_frames` 를 쓰지 않고 원본 JSON 을 직접 읽는다.** 두 가지
이유다.

  1. `_parse_507` 은 `"box"` 가 없는 어노테이션을 버린다. 행동 라벨 일부는
     **keypoint** 로 되어 있어서 그 경로로는 **0건으로 보인다.** 실제로 이 스크립트의
     첫 버전이 `UA-06` 을 0건으로 보고했다.
  2. `Raw Data Info.` 의 `situation_description` 이 코드의 한글 설명을 담고 있다.
     `Frame` 에는 그 필드가 없다.

    python scripts/scan_behavior_codes.py
    python scripts/scan_behavior_codes.py --work 비계작업 --prefix UA
"""

from __future__ import annotations

import argparse
import collections
import json
import pathlib
import statistics
import sys

ROOT = pathlib.Path(r"D:\507\label_val\122.고소작업_현장_실시간_영상_데이터"
                    r"\01.데이터\2.Validation\라벨링데이터")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--work", nargs="+", default=None,
                    help="작업유형 폴더. 기본은 전부")
    ap.add_argument("--prefix", nargs="+", default=["UA"],
                    help="이 접두사 코드만 출력. 기본 UA(불안전행동)")
    args = ap.parse_args()

    works = args.work or sorted(d.name for d in ROOT.iterdir() if d.is_dir())
    pre = tuple(args.prefix)

    shape = collections.defaultdict(collections.Counter)   # code -> box/keypoint
    frames = collections.Counter()
    per_frame = collections.defaultdict(collections.Counter)
    areas = collections.defaultdict(list)
    sites = collections.defaultdict(set)
    clips = collections.defaultdict(set)
    desc = collections.defaultdict(collections.Counter)    # code -> 한글 설명
    work_of = collections.defaultdict(collections.Counter)

    for work in works:
        d = ROOT / work
        if not d.is_dir():
            continue
        for path in d.rglob("*.json"):
            try:
                j = json.loads(path.read_text(encoding="utf-8"))
            except Exception:
                continue
            raw = j.get("Raw Data Info.", {})
            vid = raw.get("raw_data_ID") or path.stem
            parts = vid.split("_")
            site = parts[1] if len(parts) > 1 else "?"
            res = raw.get("resolution") or [0, 0]
            px = res[0] * res[1]
            seen = collections.Counter()
            for a in j.get("Learning Data Info.", {}).get("annotation", []):
                code = a.get("class_id", "?")
                if not code.startswith(pre):
                    continue
                kind = "box" if "box" in a else ("keypoint" if "keypoint" in a else "기타")
                shape[code][kind] += 1
                seen[code] += 1
                if kind == "box" and px:
                    w, h = a["box"][2], a["box"][3]
                    areas[code].append(w * h / px)
            for code, n in seen.items():
                frames[code] += 1
                per_frame[code][n] += 1
                sites[code].add(site)
                clips[code].add(vid)
                work_of[code][work] += 1
                # 상황 라벨은 프레임 전체에 붙는다. 코드와 상황 ID 가 같은 경우가 많다.
                if raw.get("situation_ID") == code and raw.get("situation_description"):
                    desc[code][raw["situation_description"]] += 1

    print(f"스캔: {', '.join(works)}   접두사 {'/'.join(pre)}\n")
    head = f"  {'코드':<8}{'형태':<10}{'인스턴스':>9}{'프레임':>8}{'현장':>5}{'클립':>5}  설명"
    print(head)
    for code in sorted(shape):
        kinds = shape[code]
        kind = "+".join(f"{k}{v:,}" for k, v in kinds.most_common())
        d0 = desc[code].most_common(1)
        label = d0[0][0] if d0 else "(상황 설명 없음)"
        print(f"  {code:<8}{kind:<10}{sum(kinds.values()):>9,}{frames[code]:>8,}"
              f"{len(sites[code]):>5}{len(clips[code]):>5}  {label}")
        a = sorted(areas[code])
        if a:
            print(f"          면적비 중앙값 {statistics.median(a):.4f}"
                  f"  10% {a[len(a)//10]:.4f}  90% {a[len(a)*9//10]:.4f}"
                  f"   현장 {sorted(sites[code])}")
        multi = {k: v for k, v in per_frame[code].items() if k > 1}
        if multi:
            print(f"          프레임당 2개 이상: {multi}")
        print(f"          작업유형 {dict(work_of[code])}")

    print()
    print("  형태가 keypoint 면 `src.data.aihub.iter_frames` 로는 보이지 않는다.")
    print("  면적비: 작업자 전신 0.01~0.05, 비계 한 칸 0.058(SO-01), 발판/작업영역 0.10~0.25.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

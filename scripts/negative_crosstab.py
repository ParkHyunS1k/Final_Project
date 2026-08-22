"""현장 × 난간 상태 교차표 — 미설치 평가셋이 성립하는지 판별한다.

**왜 필요한가.** 71407 은 정상/불량이 **다른 현장**에서 촬영됐다
(Y-04 = A18/A26 대 N-04 = A32/A35, `configs/data/class_mapping.yaml`).
그런 데이터로 정상/불량 분류를 학습하면 모델은 난간이 아니라 **현장을 식별**한다.
이 프로젝트는 그 함정에 이미 빠진 적이 있다 — `hook_stage1` 은 자기평가 mAP50
0.995 를 찍고도 알고 보니 현장 A03 의 촬영 조건 탐지기였다.

그래서 507 의 미설치 라벨을 쓰기 **전에** 같은 검사를 한다.

  `SO-01`         비계작업 WS. 안전난간이 실제로 있는 프레임
  `UC-01`/`UC-04` 비계작업 UC. 안전난간 미설치 (`class_mapping.yaml` 의 eval_only)
  `UC-03`/`UC-06` 비계작업 UC. 난간 위 발판 설치 = **난간이 있다.** negative 로
                  쓰면 안 되므로 따로 센다.

같은 현장에 `SO-01` 과 `UC-01`/`UC-04` 가 모두 있어야 "현장을 외워서" 맞히는 것을
막을 수 있다.

    python scripts/negative_crosstab.py
"""

from __future__ import annotations

import argparse
import collections
import pathlib
import statistics
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from src.data.aihub import iter_frames  # noqa: E402

LABELS = pathlib.Path(r"D:\507\label_val\122.고소작업_현장_실시간_영상_데이터"
                      r"\01.데이터\2.Validation\라벨링데이터\비계작업")
SOURCE = pathlib.Path(r"D:\507\source_val\122.고소작업_현장_실시간_영상_데이터"
                      r"\01.데이터\2.Validation\원천데이터\비계작업")

HAVE = ("SO-01",)                 # 난간 있음 (WS)
MISS = ("UC-01", "UC-04")         # 난간 미설치 (UC)
HAVE_UC = ("UC-03", "UC-06")      # 난간 위 발판 = 난간 있음. negative 아님


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--process", default="A", help="공정 코드. 기본 A=비계작업")
    args = ap.parse_args()

    index = {p.stem for p in SOURCE.rglob("*.jpg")}
    frames = collections.Counter()      # (site, code) -> 프레임 수
    boxes = collections.Counter()
    area = collections.defaultdict(list)
    clips = collections.defaultdict(lambda: collections.defaultdict(set))
    both_in_frame = collections.Counter()
    no_source = 0

    for f in iter_frames(LABELS):
        p = f.video_id.split("_")
        if len(p) < 3 or p[2] != args.process:
            continue
        site = p[1]
        codes = {a.class_code for a in f.annotations}
        W, H = f.resolution
        for group, names in (("HAVE", HAVE), ("MISS", MISS), ("HAVE_UC", HAVE_UC)):
            if codes & set(names):
                clips[site][group].add(f.video_id)
        for c in HAVE + MISS + HAVE_UC:
            if c in codes:
                frames[(site, c)] += 1
        for a in f.annotations:
            if a.class_code in HAVE + MISS:
                boxes[(site, a.class_code)] += 1
                area[a.class_code].append(a.area / (W * H))
        if (codes & set(MISS)) and (codes & set(HAVE_UC)):
            both_in_frame[site] += 1
        if (codes & set(MISS)) and f.image_id not in index:
            no_source += 1

    sites = sorted({s for s, _ in frames})
    cols = HAVE + MISS + HAVE_UC
    print(f"{'현장':<6}" + "".join(f"{c:>9}" for c in cols) + f"{'미설치+발판':>12}")
    for s in sites:
        print(f"{s:<6}" + "".join(f"{frames[(s, c)]:>9}" for c in cols)
              + f"{both_in_frame[s]:>12}")

    usable = [s for s in sites
              if any(frames[(s, c)] for c in HAVE) and any(frames[(s, c)] for c in MISS)]
    print(f"\n두 상태가 모두 있는 현장: {usable}")
    print(f"원천 이미지가 없는 미설치 프레임: {no_source}")

    print(f"\n{'코드':<8}{'박스':>8}{'면적비 중앙값':>14}")
    for c in HAVE + MISS:
        if area[c]:
            print(f"{c:<8}{len(area[c]):>8}{statistics.median(area[c]):>14.4f}")

    print("\n현장별 클립 수 (겹치면 같은 촬영에서 두 상태가 나온다는 뜻)")
    for s in usable:
        h, m = clips[s]["HAVE"], clips[s]["MISS"]
        print(f"  {s}: 난간O {len(h)}클립 / 미설치 {len(m)}클립 / 겹침 {len(h & m)}")

    if not usable:
        print("\n  -> 같은 현장에 두 상태가 없다. 71407 과 같은 교란이므로 "
              "학습에 쓰지 말고 challenge set 으로만 쓸 것.")
    else:
        print(f"\n  -> {len(usable)}개 현장에서 현장을 외워도 맞힐 수 없다. "
              "다만 클립 겹침이 0이면 촬영 조건 교란은 남는다.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

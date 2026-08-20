"""영상 단위 분할.

프레임 단위 랜덤 분할은 금지다 (README 8절). 507/71407 은 동영상에서 프레임을
추출한 데이터라 인접 프레임이 거의 동일하다. train 과 test 에 나뉘어 들어가면
성능이 크게 부풀려진다.

여기서는 영상 ID 를 단위로 나누되, 층화 기준별로 프레임 수 비율이 목표에
가깝도록 탐욕적으로 배정한다. 영상 개수가 아니라 프레임 수를 맞추는 이유는
영상마다 프레임 수가 크게 다르기 때문이다.
"""

from __future__ import annotations

import collections
import random
from dataclasses import dataclass

SPLITS = ("train", "val", "test")


@dataclass(frozen=True)
class VideoInfo:
    video_id: str
    n_frames: int
    strata: tuple[str, ...]  # 층화 키 (예: ("WS", "1"))


def split_videos(
    videos: list[VideoInfo],
    ratios: tuple[float, float, float] = (0.7, 0.15, 0.15),
    seed: int = 0,
) -> dict[str, str]:
    """영상 ID -> split 이름. 층화 기준 안에서 프레임 수 비율을 맞춘다."""
    if not videos:
        return {}
    if abs(sum(ratios) - 1.0) > 1e-6:
        raise ValueError(f"ratios 합이 1이 아닙니다: {ratios}")

    by_strata: dict[tuple, list[VideoInfo]] = collections.defaultdict(list)
    for v in videos:
        by_strata[v.strata].append(v)

    assignment: dict[str, str] = {}
    # 층화 기준 사이에도 총량이 맞도록 누적 카운터를 공유한다
    total = {s: 0 for s in SPLITS}

    for strata in sorted(by_strata):
        group = by_strata[strata]
        # 문자열 시드를 쓴다. tuple.__hash__ 는 PYTHONHASHSEED 에 따라
        # 실행마다 달라져 재현성이 깨진다.
        rng = random.Random(f"{seed}|" + "/".join(strata))
        # 순서만 섞는다. 여기서 크기순으로 정렬하면 셔플이 무효화되어
        # seed 를 바꿔도 배정이 똑같아진다. 비율은 아래 deficit 탐욕법이 맞춘다.
        rng.shuffle(group)

        for v in group:
            grand = sum(total.values()) + v.n_frames
            # 배정 후 목표 대비 부족분이 가장 큰 split 을 고른다
            deficit = {
                s: ratios[i] * grand - total[s] for i, s in enumerate(SPLITS)
            }
            pick = max(SPLITS, key=lambda s: deficit[s])
            assignment[v.video_id] = pick
            total[pick] += v.n_frames

    return assignment


def summarize(videos: list[VideoInfo], assignment: dict[str, str]) -> str:
    n_vid = collections.Counter()
    n_frm = collections.Counter()
    strata_split = collections.defaultdict(collections.Counter)
    for v in videos:
        s = assignment[v.video_id]
        n_vid[s] += 1
        n_frm[s] += v.n_frames
        strata_split["/".join(v.strata)][s] += v.n_frames

    total = sum(n_frm.values()) or 1
    lines = [f"{'split':<8}{'영상':>8}{'프레임':>10}{'비율':>9}"]
    for s in SPLITS:
        lines.append(f"{s:<8}{n_vid[s]:>8}{n_frm[s]:>10}{n_frm[s] / total:>9.1%}")
    lines.append("")
    lines.append(f"{'층화':<16}" + "".join(f"{s:>10}" for s in SPLITS))
    for k in sorted(strata_split):
        c = strata_split[k]
        lines.append(f"{k:<16}" + "".join(f"{c[s]:>10}" for s in SPLITS))
    return "\n".join(lines)

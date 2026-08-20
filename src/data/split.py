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


def kfold_videos(
    videos: list[VideoInfo], k: int = 5, seed: int = 0
) -> dict[str, int]:
    """영상 ID -> 폴드 번호(0..k-1). 층화 기준 안에서 프레임 수를 고르게 나눈다.

    영상이 15개뿐인 안전고리처럼 단일 분할의 분산이 큰 경우에 쓴다.
    """
    # k=2 면 test=fold0, val=fold1 이 되어 train 이 비어버린다.
    # test/val/train 3분할 구조상 최소 3겹이 필요하다.
    if k < 3:
        raise ValueError(f"k는 3 이상이어야 합니다 (k=2면 train이 빈다): {k}")
    n_vid = len(videos)
    if n_vid < k:
        raise ValueError(f"영상 {n_vid}개로 {k}겹을 나눌 수 없습니다")

    by_strata: dict[tuple, list[VideoInfo]] = collections.defaultdict(list)
    for v in videos:
        by_strata[v.strata].append(v)

    fold_of: dict[str, int] = {}
    load = [0] * k  # 폴드별 누적 프레임 수
    count = [0] * k  # 폴드별 누적 영상 수

    for strata in sorted(by_strata):
        group = by_strata[strata]
        rng = random.Random(f"{seed}|kfold|" + "/".join(strata))
        rng.shuffle(group)
        for v in group:
            # 프레임이 가장 적은 폴드에 넣되, 영상 수가 한쪽으로 쏠리지 않게
            # 영상 수를 2차 기준으로 쓴다. 빈 폴드가 생기면 안 된다.
            pick = min(range(k), key=lambda i: (load[i], count[i], i))
            fold_of[v.video_id] = pick
            load[pick] += v.n_frames
            count[pick] += 1

    empty = [i for i in range(k) if count[i] == 0]
    if empty:
        raise ValueError(f"폴드 {empty} 가 비었습니다. k를 줄이세요 (영상 {n_vid}개)")
    return fold_of


def fold_assignment(fold_of: dict[str, int], fold: int, k: int) -> dict[str, str]:
    """폴드 번호 배정을 특정 폴드 기준의 train/val/test 배정으로 바꾼다.

    test = fold, val = (fold+1) % k, 나머지 train.
    test 를 val 로 겸용하면 조기종료가 test 를 보게 되어 지표가 낙관적으로 샌다.
    """
    out = {}
    for vid, f in fold_of.items():
        if f == fold:
            out[vid] = "test"
        elif f == (fold + 1) % k:
            out[vid] = "val"
        else:
            out[vid] = "train"
    return out


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

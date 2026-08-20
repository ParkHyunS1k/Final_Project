"""그룹 단위 분할.

프레임 단위 랜덤 분할은 금지다 (README 8절). 507/71407 은 동영상에서 프레임을
추출한 데이터라 인접 프레임이 거의 동일하다. train 과 test 에 나뉘어 들어가면
성능이 크게 부풀려진다.

여기서 그룹은 불투명한 키다. 무엇을 한 단위로 볼지는 호출부가 정한다
(scripts/build_dataset.py 의 group_id. 현재는 촬영 현장).
층화 기준별로 프레임 수 비율이 목표에 가깝도록 탐욕적으로 배정한다.
그룹 개수가 아니라 프레임 수를 맞추는 이유는 그룹마다 프레임 수가 크게 다르기 때문이다.
"""

from __future__ import annotations

import collections
import random
from dataclasses import dataclass

SPLITS = ("train", "val", "test")


@dataclass(frozen=True)
class GroupInfo:
    group_id: str
    n_frames: int
    strata: tuple[str, ...]  # 층화 키. 그룹 안에서 상수여야 한다


def split_groups(
    groups: list[GroupInfo],
    ratios: tuple[float, float, float] = (0.7, 0.15, 0.15),
    seed: int = 0,
) -> dict[str, str]:
    """그룹 ID -> split 이름. 층화 기준 안에서 프레임 수 비율을 맞춘다."""
    if not groups:
        return {}
    if abs(sum(ratios) - 1.0) > 1e-6:
        raise ValueError(f"ratios 합이 1이 아닙니다: {ratios}")

    by_strata: dict[tuple, list[GroupInfo]] = collections.defaultdict(list)
    for v in groups:
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
            assignment[v.group_id] = pick
            total[pick] += v.n_frames

    return assignment


def kfold_groups(
    groups: list[GroupInfo], k: int = 5, seed: int = 0
) -> dict[str, int]:
    """그룹 ID -> 폴드 번호(0..k-1). 층화 기준 안에서 프레임 수를 고르게 나눈다.

    그룹이 4개뿐인 현장 단위 분할처럼 단일 분할의 분산이 큰 경우에 쓴다.
    """
    # k=2 면 train 이 그룹 하나뿐이라 "여러 현장에서 배운다" 가 성립하지 않는다.
    if k < 3:
        raise ValueError(f"k는 3 이상이어야 합니다 (k=2면 train이 그룹 1개): {k}")
    n_grp = len(groups)
    if n_grp < k:
        raise ValueError(f"그룹 {n_grp}개로 {k}겹을 나눌 수 없습니다")

    by_strata: dict[tuple, list[GroupInfo]] = collections.defaultdict(list)
    for v in groups:
        by_strata[v.strata].append(v)

    fold_of: dict[str, int] = {}
    load = [0] * k  # 폴드별 누적 프레임 수
    count = [0] * k  # 폴드별 누적 그룹 수

    for strata in sorted(by_strata):
        group = by_strata[strata]
        rng = random.Random(f"{seed}|kfold|" + "/".join(strata))
        rng.shuffle(group)
        for v in group:
            # 프레임이 가장 적은 폴드에 넣되, 그룹 수가 한쪽으로 쏠리지 않게
            # 그룹 수를 2차 기준으로 쓴다. 빈 폴드가 생기면 안 된다.
            pick = min(range(k), key=lambda i: (load[i], count[i], i))
            fold_of[v.group_id] = pick
            load[pick] += v.n_frames
            count[pick] += 1

    empty = [i for i in range(k) if count[i] == 0]
    if empty:
        raise ValueError(f"폴드 {empty} 가 비었습니다. k를 줄이세요 (그룹 {n_grp}개)")
    return fold_of


def fold_assignment(fold_of: dict[str, int], fold: int) -> dict[str, str]:
    """폴드 번호 배정을 특정 폴드 기준의 test/train 배정으로 바꾼다.

    test = fold, 나머지 train. val 은 carve_val 이 train 안에서 떼어낸다.

    한 폴드를 통째로 val 로 쓰면 안 된다. guardrail 은 SO-01 이 라벨된 현장이
    A04/A08/A17/A21 네 곳뿐이라 k=4 가 곧 leave-one-site-out 이고, 거기서 val 로
    한 현장을 더 빼면 train 이 2현장으로 줄어든다. 실측으로 fold3 은 train 이
    526프레임(전체의 27%), fold2 는 val(954) 이 train(862) 보다 컸다.

    test 현장만 완전히 분리하면 "안 본 현장에서 되는가" 를 재는 데는 충분하다.
    """
    return {g: ("test" if f == fold else "train") for g, f in fold_of.items()}


def carve_val(
    assignment: dict[str, str],
    subgroups: list[GroupInfo],
    parent_of: dict[str, str],
    ratio: float = 0.15,
) -> dict[str, str]:
    """train 그룹 안에서 하위 그룹 단위로 val 을 떼어낸다. 키가 하위 그룹으로 바뀐다.

    상위 그룹(현장)은 test 분리에만 쓰고 val 은 train 현장 안에서 조달한다.
    val 이 train 과 같은 현장이므로 val 지표는 낙관적이고 best.pt 선택이 조금
    과적합 쪽으로 치우친다. 그 대신 train 이 3현장을 다 보고, 보고 지표인 test 는
    현장이 완전히 분리된 채로 남는다. 하위 그룹은 촬영 세션이라 인접 프레임이
    train 과 val 에 나뉘어 들어가지도 않는다.

    한 현장의 세션을 전부 val 로 보내면 그 현장이 train 에서 사라지므로 막는다.
    작은 세션부터 보면서 목표 프레임 수에 가까워지는 것만 담는다. 세션이 통째로
    움직이므로 비율이 정확히 맞지는 않는다.
    """
    out = {sg.group_id: assignment[parent_of[sg.group_id]] for sg in subgroups}
    pool = [sg for sg in subgroups if out[sg.group_id] == "train"]
    target = ratio * sum(sg.n_frames for sg in pool)

    remain = collections.Counter(parent_of[sg.group_id] for sg in pool)
    n = 0
    for sg in sorted(pool, key=lambda s: (s.n_frames, s.group_id)):
        parent = parent_of[sg.group_id]
        if remain[parent] <= 1:  # 이 현장의 마지막 세션이면 train 에 남긴다
            continue
        if abs(n + sg.n_frames - target) >= abs(n - target):
            continue
        out[sg.group_id] = "val"
        remain[parent] -= 1
        n += sg.n_frames
    return out


def summarize(groups: list[GroupInfo], assignment: dict[str, str]) -> str:
    n_grp = collections.Counter()
    n_frm = collections.Counter()
    strata_split = collections.defaultdict(collections.Counter)
    for v in groups:
        s = assignment[v.group_id]
        n_grp[s] += 1
        n_frm[s] += v.n_frames
        strata_split["/".join(v.strata)][s] += v.n_frames

    total = sum(n_frm.values()) or 1
    lines = [f"{'split':<8}{'그룹':>8}{'프레임':>10}{'비율':>9}"]
    for s in SPLITS:
        lines.append(f"{s:<8}{n_grp[s]:>8}{n_frm[s]:>10}{n_frm[s] / total:>9.1%}")
    lines.append("")
    lines.append(f"{'층화':<16}" + "".join(f"{s:>10}" for s in SPLITS))
    for k in sorted(strata_split):
        c = strata_split[k]
        lines.append(f"{k:<16}" + "".join(f"{c[s]:>10}" for s in SPLITS))
    return "\n".join(lines)

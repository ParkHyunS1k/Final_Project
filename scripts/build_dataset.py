"""AI Hub 라벨을 YOLO 학습 데이터셋으로 변환한다.

configs/data/targets.yaml 의 타겟 하나를 골라 실행한다.
안전난간과 안전고리는 별도 모델이므로 별도 데이터셋을 만든다.

    python scripts/build_dataset.py guardrail --out data/yolo/guardrail
    python scripts/build_dataset.py hook      --out data/yolo/hook --dry-run

--dry-run 은 원천 이미지 없이 라벨만으로 통계와 분할을 검증한다.
"""

from __future__ import annotations

import argparse
import collections
import json
import pathlib
import sys

import yaml

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from src.data.aihub import iter_frames  # noqa: E402
from src.data.split import (  # noqa: E402
    SPLITS, VideoInfo, fold_assignment, kfold_videos, split_videos, summarize,
)

REPO = pathlib.Path(__file__).resolve().parents[1]


def load_cfg(target: str, path: pathlib.Path | None = None) -> tuple[dict, dict]:
    path = path or REPO / "configs/data/targets.yaml"
    cfg = yaml.safe_load(path.read_text(encoding="utf-8"))
    if target not in cfg:
        sys.exit(f"'{target}' 이 targets.yaml 에 없습니다. 가능: "
                 f"{[k for k in cfg if k != 'split']}")
    return cfg[target], cfg["split"]


def collect(tc: dict) -> tuple[list, list, dict]:
    """조건에 맞는 프레임을 모은다. (frames, video_meta) 반환."""
    root = REPO / tc["label_root"]
    if not root.exists():
        sys.exit(f"라벨 경로가 없습니다: {root}\n  scripts/download_aihub.sh phase0 을 먼저 실행하세요.")

    situations = set(tc["situations"])
    require = set(tc["require"])
    keep_codes = set(tc["classes"])

    positives, negatives = [], []
    meta: dict[str, dict] = {}

    for f in iter_frames(root):
        parts = f.video_id.split("_")
        if len(parts) < 3 or parts[2] != tc["process_id"]:
            continue
        raw = json.loads(f.source.read_text(encoding="utf-8"))["Raw Data Info."]
        situ = str(raw.get("situation_ID", ""))[:2]
        if situ not in situations:
            continue

        anns = [a for a in f.annotations if a.class_code in keep_codes]
        has_target = any(a.class_code in require for a in f.annotations)
        rec = (f, anns, situ, str(raw.get("device", "?")))
        (positives if has_target else negatives).append(rec)
        meta.setdefault(f.video_id, {"situation": situ, "device": str(raw.get("device", "?"))})

    return positives, negatives, meta


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("target")
    ap.add_argument("--out", type=pathlib.Path)
    ap.add_argument("--dry-run", action="store_true", help="이미지 없이 라벨만 검증")
    ap.add_argument("--copy", action="store_true", help="심볼릭 링크 대신 복사")
    ap.add_argument("--seed", type=int, help="targets.yaml 의 split.seed 를 덮어씀")
    ap.add_argument("--kfold", type=int, metavar="K",
                    help="영상 단위 group k-fold. out/fold0..foldK-1 생성")
    ap.add_argument("--targets", type=pathlib.Path,
                    help="기본 configs/data/targets.yaml 대신 쓸 정의 파일")
    args = ap.parse_args()

    tc, sc = load_cfg(args.target, args.targets)
    seed = args.seed if args.seed is not None else sc["seed"]
    out = args.out or (REPO / "data/yolo" / args.target)

    print(f"타겟 {args.target} — {tc['description']}")
    positives, negatives, meta = collect(tc)
    print(f"  조건 일치: positive {len(positives)} / negative {len(negatives)} 프레임")

    # 배경 프레임 섞기. 영상 단위 분할 전에 정해야 split 비율이 맞는다.
    keep = list(positives)
    ratio = float(tc.get("negative_ratio", 0.0))
    if ratio > 0 and negatives:
        import random
        n = min(len(negatives), int(len(positives) * ratio))
        keep += random.Random(f"{seed}|neg").sample(negatives, n)
        print(f"  배경 {n} 프레임 추가 (negative_ratio={ratio})")
    if not keep:
        sys.exit("조건에 맞는 프레임이 없습니다. targets.yaml 의 process_id/situations 를 확인하세요.")

    # ---- 원천 이미지가 있는 프레임만 남긴다.
    # 분할 후에 거르면 split 비율이 조용히 틀어진다. 반드시 분할 전에 한다.
    index = None
    if not args.dry_run:
        index = _index_images(REPO / tc["source_root"])
        before = len(keep)
        keep = [r for r in keep if r[0].image_id in index]
        if not keep:
            sys.exit("원천 이미지와 매칭되는 프레임이 없습니다. source_root 를 확인하세요.")
        if len(keep) < before:
            print(f"  원천 이미지 없는 프레임 {before - len(keep)}개 제외 -> {len(keep)}개")

    # ---- 영상 단위 분할
    per_video = collections.Counter(f.video_id for f, _, _, _ in keep)
    strata_keys = sc.get("stratify_by", [])
    videos = [
        VideoInfo(vid, n, tuple(meta[vid][k] for k in strata_keys))
        for vid, n in per_video.items()
    ]
    # ---- 클래스 매핑
    names = list(dict.fromkeys(tc["classes"].values()))
    code2id = {code: names.index(name) for code, name in tc["classes"].items()}
    print(f"\n클래스: {dict(enumerate(names))}")

    # ---- 분할. 단일 분할 또는 영상 단위 group k-fold
    if args.kfold:
        fold_of = kfold_videos(videos, args.kfold, seed)
        plans = [
            (out / f"fold{i}", fold_assignment(fold_of, i, args.kfold), f"fold {i}")
            for i in range(args.kfold)
        ]
        print(f"\n=== 영상 단위 group {args.kfold}-fold (seed={seed}) ===")
        print(f"폴드별 영상: {collections.Counter(fold_of.values())}")
        print("각 폴드에서 test=fold i, val=fold (i+1)%k, 나머지 train")
    else:
        plans = [(out, split_videos(videos, tuple(sc["ratios"]), seed),
                  f"단일 분할 seed={seed}")]

    for dest, assignment, tag in plans:
        print(f"\n----- {tag} -----")
        print(summarize(videos, assignment))
        counts = collections.defaultdict(collections.Counter)
        for f, anns, _, _ in keep:
            for a in anns:
                counts[assignment[f.video_id]][tc["classes"][a.class_code]] += 1
        print(f"{'split':<8}" + "".join(f"{n:>18}" for n in names))
        for s in SPLITS:
            print(f"{s:<8}" + "".join(f"{counts[s][n]:>18}" for n in names))

        if args.dry_run:
            continue
        _write(dest, keep, assignment, index, code2id, names, args.copy)
        meta_out = {"target": args.target, "seed": seed,
                    "stratify_by": strata_keys, "assignment": assignment}
        if args.kfold:
            meta_out |= {"kfold": args.kfold, "fold": int(dest.name.removeprefix("fold"))}
        else:
            meta_out["ratios"] = sc["ratios"]
        (dest / "split.json").write_text(
            json.dumps(meta_out, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"  -> {dest / 'data.yaml'}")

    if args.dry_run:
        print("\n--dry-run 이므로 파일을 쓰지 않았습니다.")
    return 0


def _index_images(src_root: pathlib.Path) -> dict[str, pathlib.Path]:
    """원천 구조가 라벨과 다를 수 있어 파일명(stem)으로 찾는다."""
    if not src_root.exists():
        sys.exit(f"원천 경로가 없습니다: {src_root}\n"
                 f"  scripts/download_aihub.sh phase2 를 먼저 실행하거나 --dry-run 을 쓰세요.")
    print(f"\n원천 인덱싱: {src_root}")
    index = {p.stem: p for p in src_root.rglob("*.jpg")}
    print(f"  이미지 {len(index)}장")
    return index


def _write(out, keep, assignment, index, code2id, names, copy) -> None:
    for s in SPLITS:
        (out / "images" / s).mkdir(parents=True, exist_ok=True)
        (out / "labels" / s).mkdir(parents=True, exist_ok=True)

    written, missing = collections.Counter(), []
    for f, anns, _, _ in keep:
        img = index.get(f.image_id)
        if img is None:
            missing.append(f.image_id)
            continue
        s = assignment[f.video_id]
        dst = out / "images" / s / img.name
        if not dst.exists():
            dst.write_bytes(img.read_bytes()) if copy else dst.symlink_to(img.resolve())
        W, H = f.resolution
        lines = []
        for a in anns:
            x1, y1, x2, y2 = a.bbox
            # 화면 밖으로 나간 좌표를 자른다. 안 하면 Ultralytics 가 경고를 뱉는다.
            x1, x2 = max(0.0, x1), min(float(W), x2)
            y1, y2 = max(0.0, y1), min(float(H), y2)
            if x2 <= x1 or y2 <= y1:
                continue
            lines.append(
                f"{code2id[a.class_code]} {(x1 + x2) / 2 / W:.6f} {(y1 + y2) / 2 / H:.6f} "
                f"{(x2 - x1) / W:.6f} {(y2 - y1) / H:.6f}"
            )
        (out / "labels" / s / f"{f.image_id}.txt").write_text("\n".join(lines))
        written[s] += 1

    (out / "data.yaml").write_text(yaml.safe_dump({
        "path": str(out.resolve()),
        "train": "images/train", "val": "images/val", "test": "images/test",
        "names": dict(enumerate(names)),
    }, allow_unicode=True, sort_keys=False), encoding="utf-8")

    print(f"  기록: {dict(written)}")
    if missing:
        print(f"  경고: 원천 이미지를 못 찾은 프레임 {len(missing)}개 (예: {missing[:3]})")
    empty = [s for s in SPLITS if written[s] == 0]
    if empty:
        # 빈 train 으로 학습을 걸면 Ultralytics 가 한참 뒤에 FileNotFoundError 를 뱉는다.
        raise SystemExit(f"  오류: {empty} 스플릿이 비었습니다. "
                         f"영상 수가 부족하거나 k가 너무 큽니다.")


if __name__ == "__main__":
    sys.exit(main())

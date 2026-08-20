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
from src.data.split import SPLITS, VideoInfo, split_videos, summarize  # noqa: E402

REPO = pathlib.Path(__file__).resolve().parents[1]


def load_cfg(target: str) -> tuple[dict, dict]:
    cfg = yaml.safe_load((REPO / "configs/data/targets.yaml").read_text(encoding="utf-8"))
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
    args = ap.parse_args()

    tc, sc = load_cfg(args.target)
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

    # ---- 영상 단위 분할
    per_video = collections.Counter(f.video_id for f, _, _, _ in keep)
    strata_keys = sc.get("stratify_by", [])
    videos = [
        VideoInfo(vid, n, tuple(meta[vid][k] for k in strata_keys))
        for vid, n in per_video.items()
    ]
    assignment = split_videos(videos, tuple(sc["ratios"]), seed)
    print(f"\n=== 영상 단위 분할 (seed={seed}) ===")
    print(summarize(videos, assignment))

    # ---- 클래스 매핑
    names = list(dict.fromkeys(tc["classes"].values()))
    code2id = {code: names.index(name) for code, name in tc["classes"].items()}
    print(f"\n클래스: {dict(enumerate(names))}")

    counts = collections.defaultdict(collections.Counter)
    for f, anns, _, _ in keep:
        for a in anns:
            counts[assignment[f.video_id]][tc["classes"][a.class_code]] += 1
    print(f"\n{'split':<8}" + "".join(f"{n:>18}" for n in names))
    for s in SPLITS:
        print(f"{s:<8}" + "".join(f"{counts[s][n]:>18}" for n in names))

    if args.dry_run:
        print("\n--dry-run 이므로 파일을 쓰지 않았습니다.")
        return 0

    # ---- 이미지 인덱스 (원천 구조가 라벨과 다를 수 있어 stem 으로 찾는다)
    src_root = REPO / tc["source_root"]
    if not src_root.exists():
        sys.exit(f"원천 경로가 없습니다: {src_root}\n"
                 f"  scripts/download_aihub.sh phase2 를 먼저 실행하거나 --dry-run 을 쓰세요.")
    print(f"\n원천 인덱싱: {src_root}")
    index = {p.stem: p for p in src_root.rglob("*.jpg")}
    print(f"  이미지 {len(index)}장")

    written, missing = collections.Counter(), []
    for s in SPLITS:
        (out / "images" / s).mkdir(parents=True, exist_ok=True)
        (out / "labels" / s).mkdir(parents=True, exist_ok=True)

    for f, anns, _, _ in keep:
        img = index.get(f.image_id)
        if img is None:
            missing.append(f.image_id)
            continue
        s = assignment[f.video_id]
        dst = out / "images" / s / img.name
        if not dst.exists():
            if args.copy:
                dst.write_bytes(img.read_bytes())
            else:
                dst.symlink_to(img.resolve())
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

    data_yaml = out / "data.yaml"
    data_yaml.write_text(yaml.safe_dump({
        "path": str(out.resolve()),
        "train": "images/train", "val": "images/val", "test": "images/test",
        "names": dict(enumerate(names)),
    }, allow_unicode=True, sort_keys=False), encoding="utf-8")

    (out / "split.json").write_text(json.dumps({
        "target": args.target, "seed": seed, "ratios": sc["ratios"],
        "stratify_by": strata_keys, "assignment": assignment,
    }, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"\n기록: {dict(written)}")
    if missing:
        print(f"경고: 원천 이미지를 못 찾은 프레임 {len(missing)}개 (예: {missing[:3]})")
    print(f"완료: {data_yaml}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

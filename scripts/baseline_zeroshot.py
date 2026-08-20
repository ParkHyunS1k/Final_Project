"""사전학습 PPE 모델 zero-shot 베이스라인 (README 15절 4번).

목적은 성능 측정이 아니라 **커버리지 공백의 근거 확보**다.
공개된 건설안전 PPE 모델들이 안전난간과 안전고리를 탐지하지 못한다는 것을
수치로 보여야 "왜 직접 학습하는가"가 성립한다.

    python scripts/baseline_zeroshot.py                  # 클래스 목록과 공백만 확인
    python scripts/baseline_zeroshot.py --images <디렉터리>  # 실제 추론까지

모델은 README 6절 표에 지정된 2종이다. 둘 다 Hugging Face 에서 받는다.
"""

from __future__ import annotations

import argparse
import collections
import pathlib
import sys

MODELS = {
    "melihuzunoglu/ppe-detection": "YOLOv11, AGPL-3.0",
    "Tanishjain9/yolov8n-ppe-detection-6classes": "YOLOv8n, MIT",
}

# 우리가 학습하려는 대상. 이 개념을 커버하는 클래스가 있는지 본다.
TARGETS = {
    "안전난간": ("guardrail", "railing", "handrail", "fence", "barrier"),
    "안전고리": ("hook", "lanyard", "harness", "carabiner", "anchor"),
}

IMG_EXT = {".jpg", ".jpeg", ".png", ".bmp"}


def load(repo: str):
    from huggingface_hub import hf_hub_download, list_repo_files
    from ultralytics import YOLO

    pts = [f for f in list_repo_files(repo) if f.endswith(".pt")]
    if not pts:
        raise FileNotFoundError(f"{repo} 에 .pt 파일이 없습니다")
    return YOLO(hf_hub_download(repo_id=repo, filename=pts[0]))


def covers(names: list[str], keywords: tuple[str, ...]) -> list[str]:
    low = [n.lower() for n in names]
    return [n for n, l in zip(names, low) if any(k in l for k in keywords)]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--images", type=pathlib.Path, help="추론할 이미지 디렉터리")
    ap.add_argument("--conf", type=float, default=0.25)
    ap.add_argument("--limit", type=int, default=200)
    ap.add_argument("--device", default="mps")
    args = ap.parse_args()

    imgs: list[pathlib.Path] = []
    if args.images:
        imgs = sorted(p for p in args.images.rglob("*") if p.suffix.lower() in IMG_EXT)
        imgs = imgs[: args.limit]
        if not imgs:
            print(f"이미지 없음: {args.images}")
            return 1

    gap_confirmed = True
    for repo, note in MODELS.items():
        print(f"\n=== {repo} ({note}) ===")
        try:
            model = load(repo)
        except Exception as e:  # 네트워크/레포 변경 등
            print(f"  로드 실패: {type(e).__name__}: {e}")
            continue

        names = [model.names[i] for i in sorted(model.names)]
        print(f"  클래스 {len(names)}종: {names}")

        for label, keywords in TARGETS.items():
            hit = covers(names, keywords)
            if hit:
                print(f"  {label}: 커버함 -> {hit}")
                gap_confirmed = False
            else:
                print(f"  {label}: **커버 안 함**")

        if not imgs:
            continue

        counts = collections.Counter()
        empty = 0
        for i in range(0, len(imgs), 16):
            batch = [str(p) for p in imgs[i : i + 16]]
            for r in model.predict(batch, conf=args.conf, device=args.device, verbose=False):
                cls = [model.names[int(c)] for c in r.boxes.cls]
                counts.update(cls)
                empty += not cls
        print(f"  추론 {len(imgs)}장 | 미검출 {empty} ({empty / len(imgs):.1%})")
        for n, c in counts.most_common():
            print(f"    {n:<16} {c}")

    print("\n" + "=" * 60)
    if gap_confirmed:
        print("결론: 두 모델 모두 안전난간·안전고리 클래스가 없다.")
        print("      사전학습 모델로는 이 두 대상을 탐지할 수 없으므로 직접 학습한다.")
        print("      (docs/data_plan.md 참조)")
    else:
        print("결론: 일부 타겟을 커버하는 클래스가 발견됐다. data_plan.md 를 재검토할 것.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

"""분할과 지표를 추적되는 경로(`results/`)로 모은다.

재현성 문제 하나를 고친다. `split.json` 과 `kfold_metrics.json` 은 데이터셋
디렉터리 안에서 생성되는데, 그 경로가 전부 gitignore 대상이다 — `data/yolo/`
는 `.gitignore` 의 `/data/` 에 걸리고, 실제로 쓰는 `D:/yolo/` 는 저장소 밖이다.
그래서 "분할 스크립트와 seed 를 커밋" (README 8절) 이 지켜질 수 없었다.

이미지는 옮기지 않는다. 재현에 필요한 것은 **어느 현장이 어느 split 에
갔는가**와 **그때 나온 수치**뿐이고, 둘 다 JSON 몇 KB다.

    python scripts/collect_results.py D:/yolo/guardrail
    python scripts/collect_results.py D:/yolo/guardrail_solo --name guardrail_solo
"""

from __future__ import annotations

import argparse
import pathlib
import shutil
import sys

REPO = pathlib.Path(__file__).resolve().parents[1]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("root", type=pathlib.Path, help="fold*/ 와 kfold_metrics.json 이 있는 데이터셋 루트")
    ap.add_argument("--name", help="results/ 아래 이름. 기본은 root 의 디렉터리명")
    args = ap.parse_args()

    dest = REPO / "results" / (args.name or args.root.name)
    dest.mkdir(parents=True, exist_ok=True)

    copied = []
    for split_json in sorted(args.root.glob("*/split.json")):
        target = dest / f"{split_json.parent.name}.split.json"
        shutil.copy2(split_json, target)
        copied.append(target)
    for name in ("split.json", "kfold_metrics.json"):
        src = args.root / name
        if src.exists():
            shutil.copy2(src, dest / name)
            copied.append(dest / name)

    if not copied:
        sys.exit(f"{args.root} 에서 split.json / kfold_metrics.json 을 찾지 못했습니다.")
    for p in copied:
        print(f"  {p.relative_to(REPO)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

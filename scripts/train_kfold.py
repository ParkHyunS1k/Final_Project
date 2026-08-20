"""영상 단위 group k-fold 학습·평가와 mean ± std 집계.

안전고리는 타겟이 라벨된 영상이 15개뿐이라 단일 분할의 test 가 장면 2~3개다.
그 지표는 신뢰할 수 없다. 폴드마다 학습해 평균과 표준편차로 보고한다
(README 8절 "단일 seed 결과 보고 금지").

    python scripts/build_dataset.py hook --kfold 5
    python scripts/train_kfold.py data/yolo/hook

각 폴드의 test 스플릿으로 평가한다. val 은 조기종료에만 쓴다.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import statistics
import sys

METRICS = [
    ("mAP50", "metrics/mAP50(B)"),
    ("mAP50-95", "metrics/mAP50-95(B)"),
    ("precision", "metrics/precision(B)"),
    ("recall", "metrics/recall(B)"),
]


def mean_std(xs: list[float]) -> tuple[float, float]:
    return statistics.mean(xs), (statistics.stdev(xs) if len(xs) > 1 else 0.0)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("root", type=pathlib.Path, help="fold0..foldN 이 들어있는 디렉터리")
    ap.add_argument("--cfg", type=pathlib.Path,
                    default=pathlib.Path("configs/detect/rtx4070.yaml"))
    ap.add_argument("--device", default=None, help="미지정 시 ultralytics 자동 선택")
    ap.add_argument("--epochs", type=int, default=None, help="설정 파일 값을 덮어씀")
    ap.add_argument("--name", default=None, help="실행 이름 접두사")
    args = ap.parse_args()

    folds = sorted(args.root.glob("fold*/data.yaml"))
    if not folds:
        sys.exit(f"{args.root} 아래에 fold*/data.yaml 이 없습니다.\n"
                 f"  python scripts/build_dataset.py <타겟> --kfold 5 를 먼저 실행하세요.")

    from ultralytics import YOLO
    import yaml

    cfg = yaml.safe_load(args.cfg.read_text(encoding="utf-8"))
    model_name = cfg.pop("model", "yolo26s.pt")
    cfg.pop("project", None)
    if args.epochs is not None:
        cfg["epochs"] = args.epochs
    if args.device is not None:
        cfg["device"] = args.device

    prefix = args.name or args.root.name
    per_fold, class_ap = [], {}

    for data_yaml in folds:
        fold = data_yaml.parent.name
        print(f"\n{'=' * 60}\n{prefix} / {fold}\n{'=' * 60}")

        model = YOLO(model_name)
        model.train(data=str(data_yaml.resolve()),
                    project=str((args.root / "runs").resolve()),
                    name=fold, exist_ok=True, **cfg)

        # 조기종료가 val 을 보므로 평가는 반드시 test 스플릿으로 한다
        res = model.val(data=str(data_yaml.resolve()), split="test",
                        project=str((args.root / "runs").resolve()),
                        name=f"{fold}_test", exist_ok=True,
                        device=cfg.get("device"))

        row = {"fold": fold}
        for label, key in METRICS:
            row[label] = float(res.results_dict.get(key, float("nan")))
        per_fold.append(row)

        names = res.names if isinstance(res.names, dict) else dict(enumerate(res.names))
        for i, ap50 in enumerate(getattr(res.box, "ap50", [])):
            class_ap.setdefault(names.get(i, str(i)), []).append(float(ap50))

        print(f"  {fold}: " + "  ".join(f"{k}={row[k]:.4f}" for k, _ in METRICS))

    # ---- 집계
    print(f"\n{'=' * 60}\n{prefix} — {len(per_fold)}-fold 집계\n{'=' * 60}")
    print(f"{'fold':<10}" + "".join(f"{k:>12}" for k, _ in METRICS))
    for row in per_fold:
        print(f"{row['fold']:<10}" + "".join(f"{row[k]:>12.4f}" for k, _ in METRICS))

    summary = {}
    print(f"\n{'':10}" + "".join(f"{k:>12}" for k, _ in METRICS))
    line_m, line_s = f"{'mean':<10}", f"{'std':<10}"
    for k, _ in METRICS:
        m, s = mean_std([r[k] for r in per_fold])
        summary[k] = {"mean": m, "std": s}
        line_m += f"{m:>12.4f}"
        line_s += f"{s:>12.4f}"
    print(line_m)
    print(line_s)

    if class_ap:
        print(f"\n클래스별 AP@0.5 (README 9절: 클래스별 AP 필수 보고)")
        print(f"{'클래스':<20}{'mean':>10}{'std':>10}")
        for name, xs in class_ap.items():
            m, s = mean_std(xs)
            summary.setdefault("class_ap50", {})[name] = {"mean": m, "std": s}
            print(f"{name:<20}{m:>10.4f}{s:>10.4f}")

    out = args.root / "kfold_metrics.json"
    out.write_text(json.dumps(
        {"model": model_name, "folds": per_fold, "summary": summary},
        ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n저장: {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

"""보호구(안전모) 베이스라인 — 탐지 → 위반 → 법령 → 제재 리포트.

**목적은 보험이다.** VLM 이 실패해도 돌아가는 엔드투엔드 경로를 하나 확보한다.
학습하지 않는다 — 공개 사전학습 PPE 모델을 그대로 건다.

**왜 안전모인가.**

1. **현장이 10곳**이다 (A03·A04·A15·A17·B02·C06·C15·D19·E07·E19).
   난간은 4곳뿐이라 프로젝트 전체가 막혀 있었다 (`HANDOFF.md` 3.⑤).
2. **제재를 법적으로 쓸 수 있는 유일한 항목**이다. 사업주 안전조치 의무 위반은
   과태료가 아니라 형사처벌이고, 과태료가 명확한 것은 근로자 보호구
   미착용(법 제40조)뿐이다 (`README.md` 3절).
3. 안전조끼는 **507 에 라벨이 없다.** 모델은 `vest` 를 뱉지만 채점할 정답이 없다.

**평가셋 — 507 에 '착용' positive 라벨이 없어서 이렇게 구성했다.**

    미착용  `UA-04` 상황 프레임의 `WO-04` 머리 박스   2,938 / 10현장
    착용    `UA-02`(안전벨트)·`UA-03`(안전화) 상황 프레임

`UA-02`/`UA-03` 상황에서는 작업자가 안전모를 쓰고 있다 — 상황×현장 13장을
눈으로 확인했다. **표본이 작으므로 `--audit` 로 다시 볼 것.**

집계는 `eval_protocol.md` 4.1 과 같다 — **클립 macro 가 주지표**, 대괄호는
클립 bootstrap 95%. 구역/프레임 수는 표본 수가 아니다.

    python scripts/ppe_baseline.py --limit 200
    python scripts/ppe_baseline.py --report <이미지경로>
"""

from __future__ import annotations

import argparse
import collections
import json
import pathlib
import random
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from src.report.ppe_law import VIOLATIONS  # noqa: E402
from src.report.rag_adapter import CAVEAT, Observation, run_pipeline, to_event  # noqa: E402
from src.report.render import render  # noqa: E402

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from zone_eval import boot_ci  # noqa: E402

LAB = pathlib.Path(r"D:\507\label_val\122.고소작업_현장_실시간_영상_데이터"
                   r"\01.데이터\2.Validation\라벨링데이터\공통")
SRC = pathlib.Path(r"D:\507\source_val\122.고소작업_현장_실시간_영상_데이터"
                   r"\01.데이터\2.Validation\원천데이터\공통")

# README 6절. 첫 번째만 `no-helmet` 클래스를 직접 낸다.
MODELS = {
    "melihuzunoglu/ppe-detection": "AGPL-3.0",
    "Tanishjain9/yolov8n-ppe-detection-6classes": "MIT",
}
NO_HELMET = {"no-helmet", "no_helmet", "head"}
HELMET = {"helmet", "hardhat"}

POS_SITU = "UA-04"                    # 미착용
NEG_SITU = ("UA-02", "UA-03")         # 착용 (다른 위반 상황)


def collect() -> dict:
    """현장 -> {'pos': [(img, headbox, clip)], 'neg': [(img, bodybox, clip)]}

    클립을 들고 다닌다. 인접 프레임은 독립 표본이 아니다 (`eval_protocol.md` 4.1).
    """
    index = {p.stem: p for p in SRC.rglob("*.jpg")}
    out = collections.defaultdict(lambda: {"pos": [], "neg": []})
    for path in LAB.rglob("*.json"):
        try:
            j = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        raw = j["Raw Data Info."]
        situ = raw.get("situation_ID")
        sid = j.get("Source Data Info.", {}).get("source_data_ID") or path.stem
        if sid not in index or situ not in (POS_SITU, *NEG_SITU):
            continue
        vid = raw.get("raw_data_ID", "")
        parts = vid.split("_")
        if len(parts) < 2:
            continue
        site, img = parts[1], index[sid]
        want = "WO-04" if situ == POS_SITU else situ
        for a in j["Learning Data Info."]["annotation"]:
            if a.get("class_id") == want and "box" in a:
                x, y, w, h = a["box"]
                key = "pos" if situ == POS_SITU else "neg"
                out[site][key].append((img, (x, y, x + w, y + h), vid))
                break
    return out


def sample(zones: dict, per_clip: int, seed: int) -> dict:
    """클립당 균등 추출. 프레임을 늘려도 표본은 안 는다."""
    rng = random.Random(seed)
    out = {}
    for site, kinds in zones.items():
        out[site] = {}
        for k, v in kinds.items():
            byclip = collections.defaultdict(list)
            for z in v:
                byclip[z[2]].append(z)
            picked = []
            for clip in sorted(byclip):
                picked += rng.sample(byclip[clip], min(per_clip, len(byclip[clip])))
            out[site][k] = picked
    return out


def iou(a, b) -> float:
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / ua if ua > 0 else 0.0


def macro(byclip: dict) -> tuple[float, list]:
    vals = [s / n for s, n in byclip.values()]
    return (sum(vals) / len(vals) if vals else float("nan")), vals


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="melihuzunoglu/ppe-detection",
                    choices=list(MODELS))
    ap.add_argument("--conf", type=float, default=0.25)
    ap.add_argument("--iou", type=float, default=0.3,
                    help="머리 박스와 예측이 이만큼 겹치면 맞힌 것으로 본다")
    ap.add_argument("--per-clip", type=int, default=4)
    ap.add_argument("--out", type=pathlib.Path,
                    default=pathlib.Path("outputs/ppe_baseline"))
    ap.add_argument("--report", type=pathlib.Path,
                    help="이 이미지 한 장으로 리포트만 낸다")
    ap.add_argument("--rag", type=pathlib.Path,
                    help="`산업안전RAG/` 경로. 주면 법령 연결까지 붙인다")
    ap.add_argument("--site", default="미상", help="구역명. 사진은 이걸 모른다")
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    from huggingface_hub import hf_hub_download, list_repo_files
    from ultralytics import YOLO

    args.out.mkdir(parents=True, exist_ok=True)
    pt = next(f for f in list_repo_files(args.model) if f.endswith(".pt"))
    model = YOLO(hf_hub_download(args.model, pt))
    names = model.names
    print(f"모델 {args.model} ({MODELS[args.model]})  클래스 {list(names.values())}")

    nh_ids = [i for i, n in names.items() if n.lower() in NO_HELMET]
    if not nh_ids:
        print("  ⚠ 이 모델에는 `no-helmet` 클래스가 없다. "
              "helmet 부재로 추론해야 하므로 이 스크립트로는 직접 채점할 수 없다.")
        return 1

    # ---- 리포트 한 장 모드
    if args.report:
        r = model.predict(str(args.report), conf=args.conf, verbose=False)[0]
        dets = []
        for b, c, k in zip(r.boxes.xyxy, r.boxes.conf, r.boxes.cls):
            if int(k) in nh_ids:
                dets.append({"violation": VIOLATIONS["UA-04"], "conf": float(c),
                             "box": [float(v) for v in b]})
        md = render(args.report.name, dets, site=args.site)

        if args.rag and dets:
            # 법령 연결. `detected_hazard` 는 어댑터 표에서 온다 — 지어내지 않는다.
            obs = Observation(dets[0]["violation"].code,
                              tuple(dets[0]["box"]), dets[0]["conf"],
                              args.report.name, site=args.site)
            ev = to_event(obs, event_id=f"EVT_{args.report.stem}")
            res = run_pipeline(args.rag, ev)
            head = "\n\n---\n\n## 법령 연결 (rag 브랜치 파이프라인)\n\n"
            md += head + CAVEAT + "\n\n" + res["s2_report"]
            (args.out / "s3_tbm.md").write_text(res["s3_tbm_report"], encoding="utf-8")

        (args.out / "report.md").write_text(md, encoding="utf-8")
        print(md[:1500] + ("\n...(생략)" if len(md) > 1500 else ""))
        print(f"\n저장: {args.out / 'report.md'}  ({len(md):,}자)")
        return 0

    # ---- 평가
    zones = collect()
    picks = sample(zones, args.per_clip, args.seed)
    sites = sorted(s for s in picks if picks[s]["pos"] and picks[s]["neg"])
    print(f"\n미착용·착용이 모두 있는 현장 {len(sites)}곳: {sites}")
    print(f"판정 = `no-helmet` 예측이 정답 머리 박스와 IoU >= {args.iou}")
    print("주지표는 **클립 macro**. 대괄호는 클립 bootstrap 95%\n")

    print(f"  {'현장':<6}{'미착용':>8}{'착용':>7}{'적발':>9}{'오경보':>9}{'J':>8}")
    rows = []
    for site in sites:
        agg = {"pos": collections.defaultdict(lambda: [0, 0]),
               "neg": collections.defaultdict(lambda: [0, 0])}
        for kind in ("pos", "neg"):
            for img, box, clip in picks[site][kind]:
                r = model.predict(str(img), conf=args.conf, verbose=False)[0]
                pred = [tuple(float(v) for v in b)
                        for b, k in zip(r.boxes.xyxy, r.boxes.cls) if int(k) in nh_ids]
                if kind == "pos":
                    hit = any(iou(box, p) >= args.iou for p in pred)
                else:
                    # 착용 프레임: 전신 박스 안에 no-helmet 예측이 있으면 오경보
                    hit = any(iou(box, p) >= 0.05 for p in pred)
                cell = agg[kind][clip]
                cell[1] += 1
                cell[0] += hit
        rec, recv = macro(agg["pos"])
        fa, fav = macro(agg["neg"])
        rci, fci = boot_ci(recv), boot_ci(fav)
        rs = f"[{rci[0]:.0%}-{rci[1]:.0%}]" if rci else "[구간불가]"
        fs = f"[{fci[0]:.0%}-{fci[1]:.0%}]" if fci else "[구간불가]"
        print(f"  {site:<6}{len(picks[site]['pos']):>8}{len(picks[site]['neg']):>7}"
              f"{rec:>8.1%} {rs:<12}{fa:>6.1%} {fs:<12}{rec - fa:>7.3f}")
        rows.append({"site": site, "recall": round(rec, 4), "false_alarm": round(fa, 4),
                     "j": round(rec - fa, 4), "n_pos": len(picks[site]["pos"]),
                     "n_neg": len(picks[site]["neg"]),
                     "clips_pos": len(agg["pos"]), "clips_neg": len(agg["neg"])})

    if rows:
        mr = sum(r["recall"] for r in rows) / len(rows)
        mf = sum(r["false_alarm"] for r in rows) / len(rows)
        print(f"\n  현장 macro   적발 {mr:.1%}  오경보 {mf:.1%}  J {mr - mf:.3f}")
        print("  퇴화 해: '전부 미착용' 적발 100% / 오경보 100% (J 0.000)")
        print("           '전부 착용'   적발   0% / 오경보   0% (J 0.000)")
    (args.out / "metrics.json").write_text(
        json.dumps({"model": args.model, "license": MODELS[args.model],
                    "conf": args.conf, "iou": args.iou, "sites": rows},
                   ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\n저장: {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

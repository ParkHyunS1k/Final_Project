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
from src.report.rag_adapter import (Observation, retrieved_articles,  # noqa: E402
                                    run_pipeline, to_event)
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
HUMAN = {"human", "person", "worker"}

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


def center_in(box, outer) -> bool:
    cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
    return outer[0] <= cx <= outer[2] and outer[1] <= cy <= outer[3]


def head_zone(human, top: float) -> tuple:
    """작업자 박스의 상단 `top` 비율. `top >= 1.0` 이면 전신(제한 없음).

    A03 에서 `no-helmet` 이 **등 뒤 안전대 버클**에 붙은 사례가 있다
    (`train_results.md` 5.6). 안전모는 머리에만 달리므로 상단으로 제한하면
    그런 위치 오류가 걸린다. 다만 **몸을 숙인 작업자는 머리가 아래로 내려오므로**
    비율을 너무 낮게 잡으면 정상 검출을 잃는다. 값은 스윕으로 정한다.
    """
    if top >= 1.0:
        return human
    x1, y1, x2, y2 = human
    return (x1, y1, x2, y1 + (y2 - y1) * top)


def classify(human, helmets: list, no_helmets: list, *,
             margin: float = -1.0, top: float = 1.0) -> str:
    """작업자 한 명의 착용 여부. `판정불가` 를 별도로 낸다.

    **2단계 구조의 이유.** `no-helmet` 만 보면 머리가 가려진 작업자가 탐지에도
    정답에도 안 잡혀 **분모에서 통째로 사라진다.** 사람을 먼저 세면 그 작업자가
    `판정불가` 로 남아 "못 찾은 것" 과 "판정할 수 없는 것" 이 갈린다.

    **점수를 쓴다.** `helmets`/`no_helmets` 는 `(box, conf)` 다. 예전 구현은
    박스 존재만 보고 `no-helmet` 이 하나라도 있으면 `helmet` 이 아무리 강해도
    미착용이라 했다. 그런데 실측 오경보의 정체가 **"쓴 안전모를 no-helmet 으로
    오인"** 이므로, 그 순간 `helmet` 도 함께 검출됐다면 그 정보를 버리는 셈이었다.

    - `margin < 0` 이면 예전 규칙(존재만 본다). 기본값이라 동작이 안 바뀐다.
    - `margin >= 0` 이면 **`no_helmet - helmet >= margin` 일 때만 미착용**이고,
      둘 다 있는데 마진에 못 미치면 **미착용이 아니라 `판정불가`** 로 보낸다.
      충돌을 위반 쪽으로 밀지 않는다 (`eval_protocol.md` 3.8).
    """
    zone = head_zone(human, top)
    nh = [c for b, c in no_helmets if center_in(b, zone)]
    hm = [c for b, c in helmets if center_in(b, zone)]
    if margin < 0:                       # 예전 규칙 — 존재만 본다
        return "미착용" if nh else ("착용" if hm else "판정불가")
    if not nh:
        return "착용" if hm else "판정불가"
    if max(nh) - max(hm, default=0.0) >= margin:
        return "미착용"
    return "착용" if hm else "판정불가"


# 운용점 격자. conf 는 고유 confidence 전부를 쓰므로 여기 없다.
MARGINS = (-1.0, 0.0, 0.05, 0.10, 0.20)
TOPS = (1.0, 0.5, 0.35)
FA_CAP = 0.20                          # eval_protocol 3.4 오경보 상한


def parse_conf(result, ids: dict) -> dict:
    """`{계열: [(box, conf)]}`. 한 번 추론하고 임계는 나중에 건다.

    운용점을 바꿔 가며 재려면 추론을 반복하면 안 된다 — `zone_eval.judge` 와
    같은 방식이다.
    """
    out = {k: [] for k in ids}
    for b, c, k in zip(result.boxes.xyxy, result.boxes.conf, result.boxes.cls):
        item = (tuple(float(v) for v in b), float(c))
        for name, idset in ids.items():
            if int(k) in idset:
                out[name].append(item)
    return out


def at_conf(bx: dict, c: float) -> dict:
    """임계를 건다. **`(box, conf)` 를 유지한다** — `classify` 가 점수를 쓴다."""
    return {k: [(b, cf) for b, cf in v if cf >= c] for k, v in bx.items()}


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
    ap.add_argument("--person", type=pathlib.Path,
                    help="사람 탐지를 별도 COCO 모델로 한다 (예: yolo26s.pt). "
                         "PPE 모델의 `human` 대신 쓴다")
    ap.add_argument("--person-conf", type=float, default=0.25)
    ap.add_argument("--weights", type=pathlib.Path,
                    help="PPE 가중치 파일 직접 지정. 주면 HF 허브를 안 탄다")
    ap.add_argument("--margin", type=float, default=-1.0,
                    help="no_helmet - helmet 이 이 값 이상일 때만 미착용. "
                         "음수면 예전 규칙(점수 무시)")
    ap.add_argument("--head-top", type=float, default=1.0,
                    help="작업자 박스 상단 이 비율 안의 PPE 만 머리로 본다. "
                         "1.0 이면 제한 없음")
    ap.add_argument("--sweep", action="store_true",
                    help="PPE 임계를 쓸어 보며 적발·오경보 트레이드오프를 낸다")
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    from huggingface_hub import hf_hub_download, list_repo_files
    from ultralytics import YOLO

    args.out.mkdir(parents=True, exist_ok=True)
    if args.weights:
        model = YOLO(str(args.weights))
    else:
        pt = next(f for f in list_repo_files(args.model) if f.endswith(".pt"))
        model = YOLO(hf_hub_download(args.model, pt))
    names = model.names
    print(f"모델 {args.model} ({MODELS[args.model]})  클래스 {list(names.values())}")

    ids = {
        "no_helmet": {i for i, n in names.items() if n.lower() in NO_HELMET},
        "helmet": {i for i, n in names.items() if n.lower() in HELMET},
        "human": {i for i, n in names.items() if n.lower() in HUMAN},
    }
    if not ids["no_helmet"]:
        print("  ⚠ 이 모델에는 `no-helmet` 클래스가 없다. "
              "helmet 부재로 추론해야 하므로 이 스크립트로는 직접 채점할 수 없다.")
        return 1
    person_model = None
    if args.person:
        person_model = YOLO(str(args.person))
        pid = [i for i, n in person_model.names.items() if n.lower() == "person"]
        if not pid:
            print(f"  ⚠ {args.person} 에 person 클래스가 없다.")
            return 1
        print(f"사람 탐지 {args.person} (COCO person, conf {args.person_conf})")
    elif not ids["human"]:
        print("  ⚠ 이 모델에는 사람 클래스가 없다. 2단계 판정을 쓸 수 없다.")
        return 1

    def humans(img_path, ppe_boxes):
        """사람 박스를 낸다. `--person` 이 있으면 COCO 로, 없으면 PPE 모델로."""
        if person_model is None:
            return ppe_boxes["human"]
        r = person_model.predict(str(img_path), conf=args.person_conf,
                                 verbose=False, classes=pid)[0]
        return [tuple(float(v) for v in b) for b in r.boxes.xyxy]

    # ---- 리포트 한 장 모드
    if args.report:
        r = model.predict(str(args.report), conf=args.conf, verbose=False)[0]
        bx = parse_conf(r, ids)
        bx["human"] = humans(args.report, {"human": [b for b, _ in bx["human"]]})
        conf_of = {tuple(float(v) for v in b): float(c)
                   for b, c in zip(r.boxes.xyxy, r.boxes.conf)}
        # 사람을 먼저 세고 한 명씩 판정한다. 판정불가는 위반으로 계상하지 않는다.
        dets, unresolved = [], []
        for i, h in enumerate(bx["human"], 1):
            verdict = classify(h, bx["helmet"], bx["no_helmet"],
                               margin=args.margin, top=args.head_top)
            if verdict == "미착용":
                nh = next(b for b, _ in bx["no_helmet"]
                          if center_in(b, head_zone(h, args.head_top)))
                dets.append({"violation": VIOLATIONS["UA-04"],
                             "conf": conf_of.get(nh, 0.0), "box": list(nh)})
            elif verdict == "판정불가":
                x1, y1, x2, y2 = (int(v) for v in h)
                unresolved.append(
                    f"작업자 {i} — 머리 부위에서 안전모 착용 여부를 판정하지 못함 "
                    f"(작업자 박스 [{x1}, {y1}, {x2}, {y2}])")
        arts = None
        if args.rag and dets:
            # 법령 검색은 교차 확인용이다. 조항 이름만 받고 조문 전문은 안 싣는다.
            # `detected_hazard` 는 어댑터 표에서 온다 — 지어내지 않는다.
            obs = Observation(dets[0]["violation"].code,
                              tuple(dets[0]["box"]), dets[0]["conf"],
                              args.report.name, site=args.site)
            ev = to_event(obs, event_id=f"EVT_{args.report.stem}")
            res = run_pipeline(args.rag, ev)
            arts = retrieved_articles(res["s2_report"])
            (args.out / "rag_s2_full.md").write_text(res["s2_report"], encoding="utf-8")

        md = render(args.report.name, dets, site=args.site, rag_articles=arts,
                    unresolved=unresolved)
        (args.out / "report.md").write_text(md, encoding="utf-8")
        print(md)
        print(f"\n저장: {args.out / 'report.md'}  ({len(md):,}자)")
        return 0

    # ---- 운용점 스윕. 추론은 한 번, 임계·마진·머리영역은 나중에 건다
    if args.sweep:
        zones = collect()
        picks = sample(zones, args.per_clip, args.seed)
        sites = sorted(s for s in picks if picks[s]["pos"] and picks[s]["neg"])
        cache = collections.defaultdict(list)
        confs = set()
        for site in sites:
            for kind in ("pos", "neg"):
                for img, box, clip in picks[site][kind]:
                    r = model.predict(str(img), conf=0.001, verbose=False)[0]
                    bx = parse_conf(r, ids)
                    hs = humans(img, {"human": [b for b, _ in bx["human"]]})
                    cache[(site, kind)].append((clip, box, bx, hs))
                    for k in ("helmet", "no_helmet"):
                        confs |= {round(c, 4) for _, c in bx[k]}
        grid = sorted(confs)
        combos = [(c, mg, tp) for mg in MARGINS for tp in TOPS for c in grid]
        print()
        print(f"운용점 스윕 — 현장 {len(sites)}곳. **전수 기준**"
              f"(사람미탐·기권을 분모에 남김)")
        print(f"고유 confidence {len(grid)}개 x margin {len(MARGINS)} x "
              f"top {len(TOPS)} = {len(combos):,} 조합")

        def per_site(c, mg, tp) -> dict:
            """조합 하나를 현장별로 평가한다. `{site: (적발, 오경보)}`"""
            out = {}
            for site in sites:
                agg = {"pos": collections.defaultdict(lambda: [0, 0]),
                       "neg": collections.defaultdict(lambda: [0, 0])}
                for kind in ("pos", "neg"):
                    for clip, box, bx, hs in cache[(site, kind)]:
                        f = at_conf(bx, c)
                        who = ([h for h in hs if center_in(box, h)] if kind == "pos"
                               else [h for h in hs if iou(box, h) >= 0.3])
                        v = "사람미탐" if not who else classify(
                            who[0], f["helmet"], f["no_helmet"], margin=mg, top=tp)
                        cell = agg[kind][clip]
                        cell[1] += 1
                        cell[0] += (v == "미착용")
                out[site] = (macro(agg["pos"])[0], macro(agg["neg"])[0])
            return out

        # 조합 x 현장 표를 한 번만 만든다. 이후 oracle 과 LOSO 는 집계일 뿐이다
        table = [per_site(*cb) for cb in combos]

        def agg_over(idx: int, subset: list) -> tuple:
            v = [table[idx][s] for s in subset]
            return (sum(x for x, _ in v) / len(v), sum(y for _, y in v) / len(v))

        def pick(subset: list):
            """합격 조건에 직접 맞춘 선택 — 오경보 <= 0.20 중 적발 최대.

            J 최대가 아니다. J 는 단독 합격 지표가 아니다 (`eval_protocol.md` 3.4).
            """
            best = None
            for i in range(len(combos)):
                rec, fa = agg_over(i, subset)
                if fa <= FA_CAP and (best is None or rec > best[1]):
                    best = (i, rec, fa)
            return best

        print()
        print("=== oracle (7현장 전부로 고르고 7현장에서 잰다) ===")
        o = pick(sites)
        if o:
            c, mg, tp = combos[o[0]]
            print(f"  margin {mg} / top {tp} / conf {c:.4f}"
                  f" → 적발 {o[1]:.1%} / 오경보 {o[2]:.1%}")
            print("  ** 같은 데이터에서 골랐다. 주장에 쓸 수 없다 "
                  "(eval_protocol 3.5) **")
            print()
            print("  현장별 (같은 조합 고정):")
            print(f"    {'현장':<7}{'미착용':>7}{'착용':>6}{'적발':>9}{'오경보':>9}")
            for st in sites:
                rec, fa = table[o[0]][st]
                print(f"    {st:<7}{len(picks[st]['pos']):>7}"
                      f"{len(picks[st]['neg']):>6}{rec:>9.1%}{fa:>9.1%}")

        print()
        print("=== cross-fitted LOSO (6현장에서 고르고 빠진 현장에서 잰다) ===")
        print(f"  {'held-out':<10}{'margin':>7}{'top':>6}{'conf':>8}"
              f"{'적발':>9}{'오경보':>9}")
        loso = []
        for s in sites:
            rest = [x for x in sites if x != s]
            b = pick(rest)
            if not b:
                print(f"  {s:<10}  (6현장에서 오경보 <= {FA_CAP} 조합 없음)")
                continue
            c, mg, tp = combos[b[0]]
            rec, fa = table[b[0]][s]
            print(f"  {s:<10}{mg:>7.2f}{tp:>6.2f}{c:>8.4f}{rec:>9.1%}{fa:>9.1%}")
            loso.append({"site": s, "margin": mg, "top": tp, "conf": c,
                         "recall": round(rec, 4), "fa": round(fa, 4)})
        if loso:
            mr = sum(r["recall"] for r in loso) / len(loso)
            mf = sum(r["fa"] for r in loso) / len(loso)
            print()
            print(f"  현장 macro (held-out)  적발 {mr:.1%}  오경보 {mf:.1%}")
            ok = mr >= 0.80 and mf <= FA_CAP
            print(f"  합격 기준(적발>=0.80, 오경보<={FA_CAP:.2f}): "
                  f"{'통과' if ok else '미달'}")
            print("  ** 이쪽은 빠진 현장을 선택에 쓰지 않았다. "
                  "다만 development 현장이므로 합격 선언은 아니다 (4.4절) **")
        (args.out / "sweep.json").write_text(
            json.dumps({"model": args.model, "person": str(args.person),
                        "n_conf": len(grid), "n_combo": len(combos),
                        "oracle": ({"margin": combos[o[0]][1], "top": combos[o[0]][2],
                                    "conf": combos[o[0]][0], "recall": round(o[1], 4),
                                    "fa": round(o[2], 4)} if o else None),
                        "loso": loso}, ensure_ascii=False, indent=1),
            encoding="utf-8")
        print()
        print(f"저장: {args.out / 'sweep.json'}")
        return 0

    # ---- 평가. 1단계(no-helmet 만)와 2단계(사람 먼저)를 같은 표본에서 나란히 낸다
    zones = collect()
    picks = sample(zones, args.per_clip, args.seed)
    sites = sorted(s for s in picks if picks[s]["pos"] and picks[s]["neg"])
    print(f"\n미착용·착용이 모두 있는 현장 {len(sites)}곳: {sites}")
    print(f"1단계 = `no-helmet` 예측이 정답과 겹침 (IoU >= {args.iou})")
    print("2단계 = 사람을 먼저 찾고 그 안의 PPE 박스로 판정. **판정불가를 따로 센다**")
    print("주지표는 **클립 macro**. 대괄호는 클립 bootstrap 95%\n")

    rows = []
    for site in sites:
        # [적발/오경보 수, 대상 수] — 1단계와 2단계를 따로 집계한다
        one = {"pos": collections.defaultdict(lambda: [0, 0]),
               "neg": collections.defaultdict(lambda: [0, 0])}
        two = {"pos": collections.defaultdict(lambda: [0, 0]),
               "neg": collections.defaultdict(lambda: [0, 0])}
        alls = {"pos": collections.defaultdict(lambda: [0, 0]),
                "neg": collections.defaultdict(lambda: [0, 0])}
        tally = collections.Counter()      # 2단계에서 무슨 일이 있었나
        for kind in ("pos", "neg"):
            for img, box, clip in picks[site][kind]:
                r = model.predict(str(img), conf=args.conf, verbose=False)[0]
                bx = parse_conf(r, ids)
                bx["human"] = humans(img, {"human": [b for b, _ in bx["human"]]})

                # 1단계 — 기존 방식
                if kind == "pos":
                    hit1 = any(iou(box, p) >= args.iou for p, _ in bx["no_helmet"])
                else:
                    hit1 = any(iou(box, p) >= 0.05 for p, _ in bx["no_helmet"])
                c1 = one[kind][clip]
                c1[1] += 1
                c1[0] += hit1

                # 2단계 — 정답에 해당하는 사람을 먼저 찾는다
                if kind == "pos":
                    # 정답은 맨머리 박스다. 그 머리를 품은 작업자를 찾는다
                    who = [h for h in bx["human"] if center_in(box, h)]
                else:
                    # 정답은 전신 박스다. 겹치는 작업자를 찾는다
                    who = [h for h in bx["human"] if iou(box, h) >= 0.3]
                verdict = "사람미탐" if not who else classify(
                    who[0], bx["helmet"], bx["no_helmet"],
                    margin=args.margin, top=args.head_top)
                tally[f"{kind}/{verdict}"] += 1

                # 전수 — 사람미탐·판정불가를 **분모에 남긴다.** 이쪽이 제품 수치다
                ca = alls[kind][clip]
                ca[1] += 1
                ca[0] += (verdict == "미착용")

                if verdict in ("판정불가", "사람미탐"):
                    continue               # 기권. 조건부 분모에서만 뺀다 (3.8)
                c2 = two[kind][clip]
                c2[1] += 1
                c2[0] += (verdict == "미착용")

        r1, r1v = macro(one["pos"])
        f1, f1v = macro(one["neg"])
        r2, r2v = macro(two["pos"])
        f2, f2v = macro(two["neg"])
        ra, rav = macro(alls["pos"])
        fa_, fav = macro(alls["neg"])
        rci, fci = boot_ci(r2v), boot_ci(f2v)
        rs = f"[{rci[0]:.0%}-{rci[1]:.0%}]" if rci else "[구간불가]"
        fs = f"[{fci[0]:.0%}-{fci[1]:.0%}]" if fci else "[구간불가]"
        npos, nneg = len(picks[site]["pos"]), len(picks[site]["neg"])
        miss = tally["pos/사람미탐"] + tally["neg/사람미탐"]
        abst = tally["pos/판정불가"] + tally["neg/판정불가"]
        print(f"  [{site}]  미착용 {npos} / 착용 {nneg}"
              f"   사람미탐 {miss} · 판정불가 {abst}")
        print(f"    1단계  적발 {r1:>6.1%}                오경보 {f1:>6.1%}"
              f"                J {r1 - f1:>6.3f}")
        print(f"    2단계  적발 {r2:>6.1%} {rs:<12} 오경보 {f2:>6.1%} {fs:<12}"
              f" J {r2 - f2:>6.3f}   <- 판정 가능한 경우만 (조건부)")
        print(f"    전수   적발 {ra:>6.1%}                오경보 {fa_:>6.1%}"
              f"                J {ra - fa_:>6.3f}   <- 미탐·기권 포함 (제품 수치)")
        rows.append({"site": site, "n_pos": npos, "n_neg": nneg,
                     "stage1": {"recall": round(r1, 4), "false_alarm": round(f1, 4)},
                     "stage2": {"recall": round(r2, 4), "false_alarm": round(f2, 4)},
                     "overall": {"recall": round(ra, 4), "false_alarm": round(fa_, 4)},
                     "tally": dict(tally)})

    if rows:
        def m(key, fld):
            v = [r[key][fld] for r in rows if r[key][fld] == r[key][fld]]
            return sum(v) / len(v) if v else float("nan")
        print()
        print(f"  현장 macro  1단계  적발 {m('stage1','recall'):.1%}"
              f"  오경보 {m('stage1','false_alarm'):.1%}")
        print(f"              2단계  적발 {m('stage2','recall'):.1%}"
              f"  오경보 {m('stage2','false_alarm'):.1%}   (조건부)")
        print(f"              전수   적발 {m('overall','recall'):.1%}"
              f"  오경보 {m('overall','false_alarm'):.1%}   (제품 수치)")
        tot = collections.Counter()
        for r in rows:
            tot.update(r["tally"])
        print()
        print("  2단계 내역 (구역 수):")
        for k in sorted(tot):
            print(f"    {k:<18}{tot[k]:>5}")
        print()
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

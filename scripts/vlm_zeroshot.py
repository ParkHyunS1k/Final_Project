"""VLM zero-shot 이진 파일럿 — 같은 구역에서 YOLO 와 paired 로 잰다.

`README.md` 10절 순서 4. `SO-01`(정상) / `UC-01`(미설치) 구역 crop 을 VLM 에 주고
"이 구역에 안전난간이 있는가" 를 묻는다. **집계는 `zone_eval.py` 와 같은 정의**를
쓴다 — 클립 macro 가 주지표, 대괄호는 클립 bootstrap 95% (`eval_protocol.md` 4.1).

**oracle ROI 다.** 구역이 정답 박스에서 온다. "구역이 주어졌을 때" 조건을 결과에
반드시 붙일 것 (`eval_protocol.md` 3.1).

---

**실행 전에 고정한 규칙 — 결과를 보고 바꾸지 않는다** (`eval_protocol.md` 3.2·3.8)

1. **채점 요소는 상부 난간대·중간 난간대 둘뿐이다.** 난간기둥은 정상·미설치
   양쪽에 있고 발끝막이판은 양쪽 다 없다 (`train_results.md` 1.9). 상수를
   채점하면 정확도만 부푼다.
2. **알람 규칙: 상부 난간대가 `없음` 이면 미설치 알람.** 제13조의 필수 요소다.
   중간 난간대는 함께 받되 민감도로만 본다("둘 중 하나라도 없음").
3. **기권(`판정불가`) 처리: 주지표는 기권을 빼고 재며 기권율을 병기한다.**
   경계 두 개(기권=전부 알람 / 기권=전부 무알람)를 민감도로 함께 낸다.
   3.8 의 calibration 집합 문제가 아직 미결이므로 **기권 예산은 걸지 않는다.**
4. **서브샘플은 클립당 균등**이다. 구역을 늘려도 표본은 안 는다.

**반드시 함께 보는 것** — 이것 없이는 VLM 이 무엇을 봤는지 알 수 없다.

- **면적 baseline (oracle)**: 크롭 면적비 임계 하나로 낼 수 있는 최대 J.
  `SO-01` 0.0579 대 `UC-01` 0.1111 로 면적이 2배 다르다 (`train_results.md` 1.5).
  VLM 이 이걸 못 넘으면 **난간 구조가 아니라 크롭 크기를 본 것**이다.
- **퇴화 해**: "전부 있음"(적발 0%/오경보 0%) 과 "전부 없음"(100%/100%).
- **paired YOLO**: 같은 구역에 `zone_eval.py` 와 같은 판정 규칙을 건다.

    HF_HOME=D:/hf python scripts/vlm_zeroshot.py D:/yolo/guardrail
"""

from __future__ import annotations

import argparse
import collections
import json
import pathlib
import random
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from zone_eval import boot_ci, collect_zones, judge, per_clip  # noqa: E402

MODEL = "Qwen/Qwen2.5-VL-7B-Instruct"

# 현장별 oracle conf — `train_results.md` 1.7 의 기준 B 표에서 온다.
ORACLE_CONF = {"A17": 0.005, "A04": 0.001, "A21": 0.001}

PROMPT = """이 사진은 건설현장 비계의 작업발판 한 칸이다. 안전난간을 판정하라.

- 상부 난간대: 작업발판에서 약 90cm 높이에 가로로 설치된 난간대
- 중간 난간대: 상부 난간대와 발판 사이 중간 높이의 가로 난간대

비계를 지탱하는 구조재나 대각선 가새는 난간대가 아니다.
가려지거나 화질 때문에 확신할 수 없으면 "판정불가" 로 답하라.

각각 "있음" / "없음" / "판정불가" 중 하나로만 답하고, JSON 만 출력하라.
{"상부난간대": "...", "중간난간대": "..."}"""


def parse(text: str) -> tuple[str, str]:
    """모델 출력에서 두 요소를 뽑는다. 못 뽑으면 판정불가로 센다."""
    def one(key: str) -> str:
        m = re.search(rf'"{key}"\s*:\s*"([^"]*)"', text)
        v = m.group(1).strip() if m else ""
        return v if v in ("있음", "없음", "판정불가") else "판정불가"
    return one("상부난간대"), one("중간난간대")


def sample(zones: dict, sites: list, per_clip_n: int, seed: int) -> dict:
    """현장 x 정상/미설치 x 클립으로 층화하고 클립당 균등 추출한다."""
    rng = random.Random(seed)
    out = {}
    for site in sites:
        out[site] = {}
        for kind in ("pos", "neg"):
            byclip = collections.defaultdict(list)
            for z in zones[site][kind]:
                byclip[z[2]].append(z)
            picked = []
            for clip in sorted(byclip):
                v = byclip[clip]
                picked += rng.sample(v, min(per_clip_n, len(v)))
            out[site][kind] = picked
    return out


def macro(byclip: dict) -> tuple[float, list]:
    """클립 macro 평균과 클립별 값. zone_eval 의 per_clip 과 같은 정의다."""
    vals = [s / n for s, n in byclip.values()]
    return (sum(vals) / len(vals) if vals else float("nan")), vals


def alarm_rates(rows: list, rule) -> tuple[float, float, list, list, float]:
    """(정상 알람율=오경보, 미설치 알람율=적발, 클립값들, 기권율).

    rows: (kind, clip, top, mid, area_ratio)
    rule: (top, mid) -> True(알람) / False(무알람) / None(기권)
    """
    agg = {"pos": collections.defaultdict(lambda: [0, 0]),
           "neg": collections.defaultdict(lambda: [0, 0])}
    abst = tot = 0
    for kind, clip, top, mid, _ in rows:
        tot += 1
        v = rule(top, mid)
        if v is None:
            abst += 1
            continue
        cell = agg[kind][clip]
        cell[1] += 1
        cell[0] += bool(v)
    fa, fav = macro(agg["pos"])      # 정상인데 알람 = 오경보
    rec, recv = macro(agg["neg"])    # 미설치를 알람 = 적발
    return fa, rec, fav, recv, abst / max(1, tot)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("root", type=pathlib.Path, help="D:/yolo/guardrail")
    ap.add_argument("--out", type=pathlib.Path,
                    default=pathlib.Path("outputs/vlm_zeroshot"))
    ap.add_argument("--per-clip", type=int, default=6, help="클립당 구역 수")
    ap.add_argument("--context", type=float, default=0.25, help="crop 여백 배율")
    ap.add_argument("--cov", type=float, default=0.3, help="paired YOLO 판정 임계")
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--max-pixels", type=int, default=1280 * 28 * 28)
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    import torch
    from PIL import Image
    from transformers import (AutoProcessor, BitsAndBytesConfig,
                              Qwen2_5_VLForConditionalGeneration)

    args.out.mkdir(parents=True, exist_ok=True)
    zones = collect_zones()
    sites = [s for s in sorted(zones) if zones[s]["neg"] and s in ORACLE_CONF]
    picks = sample(zones, sites, args.per_clip, args.seed)

    print(f"모델 {MODEL} (4bit) / crop 여백 {args.context} / 클립당 {args.per_clip}구역")
    print("**oracle ROI** — 구역이 정답 박스에서 온다. '구역이 주어졌을 때' 조건부다.\n")
    for s in sites:
        print(f"  {s}: 정상 {len(picks[s]['pos'])}구역 "
              f"({len({z[2] for z in picks[s]['pos']})}클립) / "
              f"미설치 {len(picks[s]['neg'])}구역 "
              f"({len({z[2] for z in picks[s]['neg']})}클립)")
    print()

    proc = AutoProcessor.from_pretrained(MODEL, max_pixels=args.max_pixels)
    model = Qwen2_5_VLForConditionalGeneration.from_pretrained(
        MODEL, dtype=torch.bfloat16, device_map="cuda:0",
        quantization_config=BitsAndBytesConfig(
            load_in_4bit=True, bnb_4bit_quant_type="nf4",
            bnb_4bit_compute_dtype=torch.bfloat16))
    model.eval()

    def ask(im) -> str:
        msg = [{"role": "user", "content": [{"type": "image", "image": im},
                                            {"type": "text", "text": PROMPT}]}]
        text = proc.apply_chat_template(msg, tokenize=False, add_generation_prompt=True)
        inp = proc(text=[text], images=[im], return_tensors="pt").to(model.device)
        with torch.inference_mode():
            out = model.generate(**inp, max_new_tokens=48, do_sample=False)
        return proc.batch_decode(out[:, inp.input_ids.shape[1]:],
                                 skip_special_tokens=True)[0]

    rows, raw = [], []
    for site in sites:
        for kind in ("pos", "neg"):
            for i, (img, box, clip) in enumerate(picks[site][kind]):
                full = Image.open(img).convert("RGB")
                x1, y1, x2, y2 = box
                m = max(x2 - x1, y2 - y1) * args.context
                cr = full.crop((max(0, x1 - m), max(0, y1 - m),
                                min(full.width, x2 + m), min(full.height, y2 + m)))
                ar = (x2 - x1) * (y2 - y1) / (full.width * full.height)
                txt = ask(cr)
                top, mid = parse(txt)
                rows.append((site, kind, clip, top, mid, ar))
                raw.append({"site": site, "kind": kind, "clip": clip,
                            "frame": img.name, "area_ratio": round(ar, 4),
                            "top": top, "mid": mid, "raw": txt.strip()[:200]})
                if len(raw) % 25 == 0:
                    print(f"  ... {len(raw)}구역")
    (args.out / "raw.json").write_text(
        json.dumps(raw, ensure_ascii=False, indent=1), encoding="utf-8")

    # ---- 규칙 (실행 전에 고정된 것)
    def primary(top, mid):
        return None if top == "판정불가" else (top == "없음")

    def abstain_alarm(top, mid):
        return True if top == "판정불가" else (top == "없음")

    def abstain_quiet(top, mid):
        return False if top == "판정불가" else (top == "없음")

    def either(top, mid):
        if top == "판정불가" and mid == "판정불가":
            return None
        return top == "없음" or mid == "없음"

    print("\n" + "=" * 78)
    print("VLM zero-shot — 클립 macro 가 주지표. 대괄호는 클립 bootstrap 95%")
    print("합격 기준: 적발 >= 0.80 이면서 오경보 <= 0.20 (eval_protocol 3.4)")
    print("=" * 78)

    for site in sites:
        sr = [(k, c, t, m, a) for s, k, c, t, m, a in rows if s == site]
        print(f"\n[{site}]")
        for name, rule in (("주지표 (기권 제외)", primary),
                           ("기권=알람", abstain_alarm),
                           ("기권=무알람", abstain_quiet),
                           ("둘 중 하나라도 없음", either)):
            fa, rec, fav, recv, ab = alarm_rates(sr, rule)
            rci, fci = boot_ci(recv), boot_ci(fav)
            rs = f"[{rci[0]:.0%}-{rci[1]:.0%}]" if rci else "[구간불가]"
            fs = f"[{fci[0]:.0%}-{fci[1]:.0%}]" if fci else "[구간불가]"
            print(f"  {name:<20} 적발 {rec:>6.1%} {rs:<12} "
                  f"오경보 {fa:>6.1%} {fs:<12} J {rec - fa:>6.3f}  기권 {ab:.1%}")

        # 퇴화 해
        print(f"  {'퇴화: 전부 있음':<20} 적발   0.0%              오경보   0.0%"
              f"              J  0.000")
        print(f"  {'퇴화: 전부 없음':<20} 적발 100.0%              오경보 100.0%"
              f"              J  0.000")

        # 면적 baseline — 임계를 test 에서 고르므로 상한이다
        best = (-9, None)
        for th in [i / 200 for i in range(1, 60)]:
            agg = {"pos": collections.defaultdict(lambda: [0, 0]),
                   "neg": collections.defaultdict(lambda: [0, 0])}
            for k, c, _, _, a in sr:
                cell = agg[k][c]
                cell[1] += 1
                cell[0] += a >= th          # 크면 미설치라고 예측
            fa, _ = macro(agg["pos"])
            rec, _ = macro(agg["neg"])
            if rec - fa > best[0]:
                best = (rec - fa, th, rec, fa)
        print(f"  {'면적 baseline(oracle)':<20} 적발 {best[2]:>6.1%}"
              f"              오경보 {best[3]:>6.1%}"
              f"              J {best[0]:>6.3f}  (면적비>={best[1]:.3f})")

    # ---- paired YOLO — 같은 구역, 같은 판정 규칙
    print("\n" + "=" * 78)
    print(f"paired YOLO (같은 구역 / cov {args.cov:.0%} / 현장별 oracle conf)")
    print("=" * 78)
    from ultralytics import YOLO
    fold_of_site = {}
    for sj in sorted(args.root.glob("fold*/split.json")):
        for s, v in json.loads(sj.read_text(encoding="utf-8"))["assignment"].items():
            if v == "test":
                fold_of_site[s.split("_")[1]] = sj.parent.name
    for site in sites:
        conf = ORACLE_CONF[site]
        w = args.root / "runs" / fold_of_site[site] / "weights" / "best.pt"
        ym = YOLO(str(w))
        p = judge(ym, picks[site]["pos"], args.imgsz, (conf,))
        n = judge(ym, picks[site]["neg"], args.imgsz, (conf,))
        det, dv = macro(per_clip(p, conf, args.cov, 0))
        said, sv = macro(per_clip(n, conf, args.cov, 0))
        rec, recv = 1 - said, [1 - v for v in sv]
        rci, fci = boot_ci(recv), boot_ci(dv)
        rs = f"[{rci[0]:.0%}-{rci[1]:.0%}]" if rci else "[구간불가]"
        fs = f"[{1 - fci[1]:.0%}-{1 - fci[0]:.0%}]" if fci else "[구간불가]"
        print(f"  {site}  conf {conf:<6.3f} 적발 {rec:>6.1%} {rs:<12} "
              f"오경보 {1 - det:>6.1%} {fs:<12} J {rec + det - 1:>6.3f}")

    print(f"\n저장: {args.out / 'raw.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

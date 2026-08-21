"""71407 을 guardrail 모델의 외부 검증셋으로 변환한다.

학습은 507 로만 한다 (docs/data_plan.md 1.3절). 71407 은 촬영 사업도 현장도
다르므로, 507 의 안 본 현장보다 한 단계 더 먼 "다른 데이터셋에서 되는가" 를 잰다.

    python scripts/build_eval_71407.py --out D:/yolo/eval71407
    yolo val model=D:/yolo/guardrail/runs/fold0/weights/best.pt \
              data=D:/yolo/eval71407/data.yaml split=val classes=0

**Y-04 의 SO-01 만 쓴다.** 71407 에서 안전난간 코드는 SO-01(개구부),
SO-04(단부 청색패널), SO-06(비계) 세 개인데 (configs/data/class_mapping.yaml),
원천을 받아 둔 시나리오 중 이 코드가 나오는 것은 Y-04 뿐이다.

Y-05 의 SO-02 는 제외한다. 계획서 1.3절이 교차검증 대상으로 적어 두었으나
박스를 잘라 보니 **화면 전체를 덮는 영역 박스**다. 난간은 화면 상단에 걸쳐
있는데 박스가 철근과 슬래브까지 전부 포함한다. 탐지 정답이 아니다.
class_mapping.yaml 이 SO-02 를 매핑하지 않은 것이 맞다.

클래스 ID 는 학습 데이터셋과 같게 유지한다 (0 guardrail / 1 work_platform /
2 worker). Y-04 에는 작업자 라벨이 없으므로 평가는 `classes=0` 으로 건다.
그렇게 하지 않으면 모델이 뱉는 work_platform·worker 예측이 정답 없는
false positive 로 잡혀 mAP 가 의미 없이 깎인다.
"""

from __future__ import annotations

import argparse
import io
import json
import pathlib
import zipfile

import yaml

ROOT = pathlib.Path(r"D:\71407")
DATA = "227.건설_현장_위험_상태_판단_데이터/01-1.정식개방데이터"
# 라벨과 원천을 따로 받았으므로 최상위 디렉터리가 갈린다 (label_* / source_*)
PARTS = [  # (라벨 zip, 원천 zip)
    (ROOT / "label_train" / DATA / "Training/02.라벨링데이터" / "TL_5대사고유형_추락_정상_Y-04.zip",
     ROOT / "source_train" / DATA / "Training/01.원천데이터" / "TS_5대사고유형_추락_정상_Y-04.zip"),
    (ROOT / "label_val" / DATA / "Validation/02.라벨링데이터" / "VL_5대사고유형_추락_정상_Y-04.zip",
     ROOT / "source_val" / DATA / "Validation/01.원천데이터" / "VS_5대사고유형_추락_정상_Y-04.zip"),
]
KEEP = "SO-01"          # 개구부 안전난간. class_mapping.yaml 에서 verified
NAMES = {0: "guardrail", 1: "work_platform", 2: "worker"}


def bounds(a: dict) -> tuple[float, float, float, float]:
    v = a["value"]
    if a["type"] == "polygon":
        return min(v[0::2]), min(v[1::2]), max(v[0::2]), max(v[1::2])
    x, y, w, h = v
    return x, y, x + w, y + h


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=pathlib.Path, default=pathlib.Path("D:/yolo/eval71407"))
    args = ap.parse_args()

    img_dir, lab_dir = args.out / "images/val", args.out / "labels/val"
    for d in (img_dir, lab_dir):
        d.mkdir(parents=True, exist_ok=True)

    written, boxes = 0, 0
    per_site: dict[str, list[str]] = {}
    for lz, sz in PARTS:
        for p in (lz, sz):
            if not p.exists():
                raise SystemExit(f"없는 파일: {p}\n  scripts/download_aihub.sh phase2 를 확인하세요.")
        with zipfile.ZipFile(lz) as lf, zipfile.ZipFile(sz) as sf:
            imgs = {pathlib.PurePosixPath(x).name: x for x in sf.namelist()
                    if x.lower().endswith(".jpg")}
            for m in sorted(x for x in lf.namelist() if x.lower().endswith(".json")):
                d = json.loads(lf.read(m).decode("utf-8-sig"))
                raw = d["Raw_Data_Info."]
                anns = [a for a in d["Learning_Data_Info."]["Annotations"]
                        if a["class_ID"] == KEEP]
                if not anns:
                    continue
                name = pathlib.PurePosixPath(m).stem + ".jpg"
                if name not in imgs:
                    continue
                W, H = (float(v) for v in raw["Resolution"].split(","))
                lines = []
                for a in anns:
                    x1, y1, x2, y2 = bounds(a)
                    x1, x2 = max(0.0, x1), min(W, x2)
                    y1, y2 = max(0.0, y1), min(H, y2)
                    if x2 <= x1 or y2 <= y1:
                        continue
                    lines.append(f"0 {(x1 + x2) / 2 / W:.6f} {(y1 + y2) / 2 / H:.6f} "
                                 f"{(x2 - x1) / W:.6f} {(y2 - y1) / H:.6f}")
                if not lines:
                    continue
                (img_dir / name).write_bytes(sf.read(imgs[name]))
                (lab_dir / f"{pathlib.PurePosixPath(m).stem}.txt").write_text("\n".join(lines))
                written += 1
                boxes += len(lines)
                per_site.setdefault(name.split("_")[1], []).append(str(img_dir / name))

    # 평가 전용이라 train 은 쓰지 않지만, Ultralytics 가 data.yaml 에 train 키를
    # 요구하므로 val 을 가리켜 둔다 (없으면 SyntaxError 로 죽는다).
    (args.out / "data.yaml").write_text(yaml.safe_dump(
        {"path": str(args.out.resolve()), "train": "images/val", "val": "images/val",
         "names": NAMES},
        allow_unicode=True, sort_keys=False), encoding="utf-8")

    # 현장별로도 따로 잰다. 두 현장의 프레임 수가 A26 1,600 / A18 200 으로 8배
    # 차이나서 합산 지표가 A26 하나에 지배된다. 파일 목록(txt)을 val 로 주면
    # 이미지를 복제하지 않고 부분집합을 평가할 수 있다.
    for sid, paths in sorted(per_site.items()):
        (args.out / f"site_{sid}.txt").write_text("\n".join(paths), encoding="utf-8")
        (args.out / f"data_{sid}.yaml").write_text(yaml.safe_dump(
            {"path": str(args.out.resolve()), "train": f"site_{sid}.txt",
             "val": f"site_{sid}.txt", "names": NAMES},
            allow_unicode=True, sort_keys=False), encoding="utf-8")

    print(f"이미지 {written}장 / SO-01 박스 {boxes}개")
    for sid, paths in sorted(per_site.items()):
        print(f"  현장 {sid}: {len(paths)}장  -> data_{sid}.yaml")
    print(f"  -> {args.out / 'data.yaml'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

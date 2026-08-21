"""71407 추락 시나리오 20종의 주 클래스·현장 구성을 라벨만으로 뽑는다.

`class_mapping.yaml` 의 71407 시나리오 표는 03~05 여섯 개만 적혀 있었다.
난간 코드(`SO-01` 개구부 / `SO-04` 단부 / `SO-06` 비계)가 어느 시나리오에
있는지, 현장이 몇 곳인지가 원천 추가 다운로드 여부를 가르는 근거이므로
그 산출 과정을 스크립트로 남긴다. 원천 없이 라벨 zip 8 MB 만으로 돌아간다.

    python scripts/scan_71407_scenarios.py

`Main_class_ID` 는 프레임마다 기록된 그 장면의 주 대상이고, `Location_ID` 가
촬영 현장이다. 현장 수가 곧 분할 가능한 그룹 수다 (README 8절).
"""

from __future__ import annotations

import argparse
import collections
import json
import pathlib
import zipfile

VAL = ("227.건설_현장_위험_상태_판단_데이터/01-1.정식개방데이터/"
       "Validation/02.라벨링데이터")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--labels", type=pathlib.Path,
                    default=pathlib.Path(r"D:\71407\label_val") / VAL)
    ap.add_argument("--every", type=int, default=10, help="Raw 정보는 N프레임마다 1장만 읽는다")
    args = ap.parse_args()

    zips = sorted(args.labels.glob("*.zip"))
    if not zips:
        raise SystemExit(f"라벨 zip 이 없습니다: {args.labels}")

    print(f"{'시나리오':<10}{'주 클래스':<12}{'현장':<18}{'프레임':>8}  클래스 인스턴스")
    for z in zips:
        scen = z.stem.split("_")[-1]
        codes = collections.Counter()
        mains: collections.Counter[str] = collections.Counter()
        sites: set = set()
        with zipfile.ZipFile(z) as zf:
            members = [x for x in zf.namelist() if x.lower().endswith(".json")]
            for i, m in enumerate(members):
                d = json.loads(zf.read(m).decode("utf-8-sig"))
                for a in d["Learning_Data_Info."]["Annotations"]:
                    codes[a["class_ID"]] += 1
                if i % args.every == 0:
                    raw = d["Raw_Data_Info."]
                    mains[raw["Main_class_ID"]] += 1
                    sites.add(raw["Location_ID"])
        main_id = mains.most_common(1)[0][0] if mains else "?"
        inst = "  ".join(f"{c}:{n}" for c, n in codes.most_common(4)
                         if c != scen)   # 시나리오 코드 자신은 장면 라벨이라 뺀다
        print(f"{scen:<10}{main_id:<12}{str(sorted(sites)):<18}{len(members):>8}  {inst}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

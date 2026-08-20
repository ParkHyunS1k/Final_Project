#!/usr/bin/env bash
# AI Hub 선택 다운로드. filekey 근거는 docs/data_plan.md 3절 참조.
#
#   .env 에 AIHUB_KEY 를 넣어두면 자동으로 읽는다 (.env.example 참고)
#
#   scripts/download_aihub.sh phase0     # 라벨 전량 0.76GB
#   scripts/download_aihub.sh phase2     # 원천 65GB
#
# 507은 zip이 작업유형 단위라 클래스별 선택이 불가능하다.
# 71407은 시나리오 단위라 정밀 선택이 된다.

set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"

# .env 로드. 이미 export된 환경변수가 우선한다.
if [[ -f "$REPO/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$REPO/.env"
  set +a
fi

if [[ -z "${AIHUB_KEY:-}" ]]; then
  echo "AIHUB_KEY 가 비어 있습니다." >&2
  echo "  $REPO/.env 파일에 AIHUB_KEY=발급받은키 를 넣으세요 (.env.example 참고)" >&2
  exit 1
fi

DATA_DIR="${DATA_DIR:-$REPO/data/raw}"

# 507 라벨 — 원천의 1/700 크기. 450GB 분량의 클래스 분포를 여기서 다 본다.
K507_TL=68026,68027,68028,68029,68030,68031          # Training  633MB
K507_VL=68020,68021,68022,68023,68024,68025          # Validation 78MB

# 507 Validation 원천.
# Phase 0 교차표 결과 타겟 클래스가 작업유형에 배타적으로 몰려 있다.
#   안전난간 SO-01 58,614  -> 비계작업에만 (다른 5개 작업유형은 0건)
#   안전고리 WO-06 36,454  -> 공통에만     (다른 5개 작업유형은 0건)
# 따라서 개구부·로프·사다리·고소작업대는 받을 이유가 없다. 56GB -> 38GB.
K507_VS_공통=68034                                    # 15GB, 안전고리
K507_VS_비계=68036                                    # 23GB, 안전난간
K507_VS="$K507_VS_공통,$K507_VS_비계"                  # 38GB

# 9종 전체로 확장할 때 추가로 필요한 것 (지금은 받지 않는다)
#   68033 고소작업대 14GB : WO-08 36,063
#   68069 사다리     3GB  : UC-08 2,149

# 71407 추락 라벨 전량 (N-01~10, Y-01~10) — 시나리오 명칭 실측 확인용
K71407_TL=$(seq 487824 487843 | paste -sd, -)        # 45MB
K71407_VL=$(seq 488050 488069 | paste -sd, -)        # 6MB

# 71407 추락 03·04·05 원천 (개구부 덮개 / 개구부 안전난간 / 단부 안전난간)
K71407_TS=487713,487714,487715,487723,487724,487725  # 8GB
K71407_VS=487939,487940,487941,487949,487950,487951  # 1.3GB

# aihubshell(v0.6)의 merge_parts 는 병합에 실패하면 빈 파일을 만든 뒤
#   rm "${prefix}".part*
# 로 원본 part를 지운다. 실패해도 종료코드가 0이라 조용히 0바이트만 남는다.
# 실제로 라벨 52개 전량이 0바이트가 되는 것을 확인했다.
# 그래서 aihubshell 을 쓰지 않고 직접 받아서 직접 병합한다.

API=https://api.aihub.or.kr/down/0.6

merge_parts() {  # merge_parts <루트디렉터리>
  python3 - "$1" <<'PY'
import pathlib, re, shutil, sys

root = pathlib.Path(sys.argv[1])
groups = {}
for p in root.rglob("*"):
    m = re.fullmatch(r"(.+)\.part(\d+)", p.name)
    if m and p.is_file():
        groups.setdefault(p.parent / m.group(1), []).append((int(m.group(2)), p))

for target, parts in sorted(groups.items()):
    parts.sort()
    with open(target, "wb") as out:          # 대용량 대비 스트리밍 복사
        for _, p in parts:
            with open(p, "rb") as src:
                shutil.copyfileobj(src, out, 1 << 20)
    size = target.stat().st_size
    if size == 0:
        sys.exit(f"병합 결과가 0바이트입니다: {target}")
    for _, p in parts:
        p.unlink()
    print(f"    {target.name}  {size/1048576:.1f} MB  (part {len(parts)}개)")
PY
}

fetch() {  # fetch <datasetkey> <filekeys> <하위디렉터리> <설명>
  local ds=$1 keys=$2 sub=$3 desc=$4
  local dest="$DATA_DIR/$sub"
  echo "==> [$ds] $desc -> $dest"
  mkdir -p "$dest"
  local tarf="$dest/.download.tar"
  curl -fL --retry 3 --retry-delay 5 -H "apikey:$AIHUB_KEY" \
       -o "$tarf" "$API/${ds}.do?fileSn=${keys}"
  tar -xf "$tarf" -C "$dest"
  rm -f "$tarf"
  merge_parts "$dest"
}

case "${1:-}" in
  phase0)
    fetch 507   "$K507_TL"    507/label_train      "Training 라벨 전량 633MB"
    fetch 507   "$K507_VL"    507/label_val        "Validation 라벨 전량 78MB"
    fetch 71407 "$K71407_TL"  71407/label_train    "추락 Training 라벨 전량 45MB"
    fetch 71407 "$K71407_VL"  71407/label_val      "추락 Validation 라벨 전량 6MB"
    ;;
  phase2)
    fetch 507   "$K507_VS"    507/source_val       "Validation 원천 공통+비계 38GB"
    fetch 71407 "$K71407_TS"  71407/source_train   "추락 03·04·05 Training 원천 8GB"
    fetch 71407 "$K71407_VS"  71407/source_val     "추락 03·04·05 Validation 원천 1.3GB"
    ;;
  *)
    echo "usage: $0 {phase0|phase2}" >&2
    exit 1
    ;;
esac

echo "완료: $DATA_DIR"

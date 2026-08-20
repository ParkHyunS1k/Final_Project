#!/usr/bin/env bash
# AI Hub 선택 다운로드. filekey 근거는 docs/data_plan.md 3절 참조.
#
#   export AIHUB_KEY=...
#   scripts/download_aihub.sh phase0     # 라벨 전량 0.76GB
#   scripts/download_aihub.sh phase2     # 원천 65GB
#
# 507은 zip이 작업유형 단위라 클래스별 선택이 불가능하다.
# 71407은 시나리오 단위라 정밀 선택이 된다.

set -euo pipefail

: "${AIHUB_KEY:?export AIHUB_KEY=... 가 필요합니다 (AI Hub 마이페이지 API 키)}"
DATA_DIR="${DATA_DIR:-$(cd "$(dirname "$0")/.." && pwd)/data/raw}"

# 507 라벨 — 원천의 1/700 크기. 450GB 분량의 클래스 분포를 여기서 다 본다.
K507_TL=68026,68027,68028,68029,68030,68031          # Training  633MB
K507_VL=68020,68021,68022,68023,68024,68025          # Validation 78MB

# 507 Validation 원천 — 6개 작업유형 전부 포함, 전체의 약 11%. 이것이 우리 학습 데이터 전량.
# 개구부 488MB / 고소작업대 14GB / 공통 15GB / 로프 428MB / 비계 23GB / 사다리 3GB
K507_VS=68032,68033,68034,68035,68036,68069          # 56GB

# 71407 추락 라벨 전량 (N-01~10, Y-01~10) — 시나리오 명칭 실측 확인용
K71407_TL=$(seq 487824 487843 | paste -sd, -)        # 45MB
K71407_VL=$(seq 488050 488069 | paste -sd, -)        # 6MB

# 71407 추락 03·04·05 원천 (개구부 덮개 / 개구부 안전난간 / 단부 안전난간)
K71407_TS=487713,487714,487715,487723,487724,487725  # 8GB
K71407_VS=487939,487940,487941,487949,487950,487951  # 1.3GB

fetch() {  # fetch <datasetkey> <filekeys> <하위디렉터리> <설명>
  local ds=$1 keys=$2 sub=$3 desc=$4
  local dest="$DATA_DIR/$sub"
  echo "==> [$ds] $desc -> $dest"
  mkdir -p "$dest"
  ( cd "$dest" && aihubshell -aihubapikey "$AIHUB_KEY" -mode d -datasetkey "$ds" -filekey "$keys" )
}

case "${1:-}" in
  phase0)
    fetch 507   "$K507_TL"    507/label_train      "Training 라벨 전량 633MB"
    fetch 507   "$K507_VL"    507/label_val        "Validation 라벨 전량 78MB"
    fetch 71407 "$K71407_TL"  71407/label_train    "추락 Training 라벨 전량 45MB"
    fetch 71407 "$K71407_VL"  71407/label_val      "추락 Validation 라벨 전량 6MB"
    ;;
  phase2)
    fetch 507   "$K507_VS"    507/source_val       "Validation 원천 전량 56GB"
    fetch 71407 "$K71407_TS"  71407/source_train   "추락 03·04·05 Training 원천 8GB"
    fetch 71407 "$K71407_VS"  71407/source_val     "추락 03·04·05 Validation 원천 1.3GB"
    ;;
  *)
    echo "usage: $0 {phase0|phase2}" >&2
    exit 1
    ;;
esac

echo "완료: $DATA_DIR"

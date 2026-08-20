"""AI Hub 507 / 71407 라벨 JSON 파서.

두 데이터셋은 JSON 키 이름과 어노테이션 표현이 다르다.

    507   "Learning Data Info." / "class_id"  / box=[x, y, w, h]
    71407 "Learning_Data_Info." / "class_ID"  / type=polygon|bbox, value=[...]

클래스 코드도 체계가 다르다. 같은 WO-04가 507에서는 안전모 미착용,
71407에서는 이동식비계다. 코드 문자열로 두 데이터셋을 병합하지 말 것.
자세한 내용은 configs/data/class_mapping.yaml 참조.
"""

from __future__ import annotations

import json
import pathlib
from dataclasses import dataclass
from typing import Iterator, Literal

Dataset = Literal["507", "71407"]


@dataclass(frozen=True)
class Annotation:
    class_code: str
    bbox: tuple[float, float, float, float]  # x1, y1, x2, y2
    shape: Literal["box", "polygon"]

    @property
    def area(self) -> float:
        x1, y1, x2, y2 = self.bbox
        return max(0.0, x2 - x1) * max(0.0, y2 - y1)


@dataclass(frozen=True)
class Frame:
    dataset: Dataset
    image_id: str
    video_id: str  # 영상 단위 분할의 키. 프레임 단위로 나누면 성능이 부풀려진다
    situation_id: str
    resolution: tuple[int, int]
    annotations: tuple[Annotation, ...]
    source: pathlib.Path


def _xywh(v: list[float]) -> tuple[float, float, float, float]:
    x, y, w, h = v
    return (x, y, x + w, y + h)


def _polygon_bounds(v: list[float]) -> tuple[float, float, float, float]:
    xs, ys = v[0::2], v[1::2]
    return (min(xs), min(ys), max(xs), max(ys))


def _parse_507(d: dict, path: pathlib.Path) -> Frame:
    raw, learn = d["Raw Data Info."], d["Learning Data Info."]
    image_id = learn["json_data_ID"]
    anns = tuple(
        Annotation(a["class_id"], _xywh(a["box"]), "box")
        for a in learn["annotation"]
        if "box" in a
    )
    return Frame(
        dataset="507",
        image_id=image_id,
        video_id=raw.get("raw_data_ID") or image_id.rsplit("_", 1)[0],
        situation_id=raw.get("situation_ID", ""),
        resolution=tuple(raw["resolution"]),
        annotations=anns,
        source=path,
    )


def _parse_71407(d: dict, path: pathlib.Path) -> Frame:
    raw, learn = d["Raw_Data_Info."], d["Learning_Data_Info."]
    image_id = learn["Json_Data_ID"]
    anns = []
    for a in learn["Annotations"]:
        v = a["value"]
        if a["type"] == "polygon":
            anns.append(Annotation(a["class_ID"], _polygon_bounds(v), "polygon"))
        else:
            anns.append(Annotation(a["class_ID"], _xywh(v), "box"))
    w, h = (int(t) for t in raw["Resolution"].split(","))
    return Frame(
        dataset="71407",
        image_id=image_id,
        video_id=raw.get("Raw_data_ID") or image_id.rsplit("_", 1)[0],
        situation_id=raw.get("Situation_ID", "").strip(),
        resolution=(w, h),
        annotations=tuple(anns),
        source=path,
    )


def load_frame(path: pathlib.Path) -> Frame:
    d = json.loads(path.read_text(encoding="utf-8"))
    if "Learning Data Info." in d:
        return _parse_507(d, path)
    if "Learning_Data_Info." in d:
        return _parse_71407(d, path)
    raise ValueError(f"알 수 없는 라벨 포맷: {path}")


def iter_frames(root: pathlib.Path) -> Iterator[Frame]:
    """root 아래 모든 라벨 JSON을 읽는다. 깨진 파일은 건너뛰고 경고한다."""
    for path in sorted(root.rglob("*.json")):
        try:
            yield load_frame(path)
        except (ValueError, KeyError, json.JSONDecodeError) as e:
            print(f"  skip {path.name}: {type(e).__name__} {e}")

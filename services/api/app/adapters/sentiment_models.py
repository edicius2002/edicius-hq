from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import UTC, datetime
from typing import Any, Literal, cast

SentimentClassification = Literal[
    "extreme fear",
    "fear",
    "neutral",
    "greed",
    "extreme greed",
]
SentimentSource = Literal["cnn", "cnn-mirror"]


def _iso(value: datetime) -> str:
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def _datetime(value: object, field: str) -> datetime:
    if not isinstance(value, str):
        raise ValueError(f"{field} must be an ISO timestamp")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError(f"{field} must include a timezone")
    return parsed.astimezone(UTC)


def _classification(value: object) -> SentimentClassification:
    allowed = {"extreme fear", "fear", "neutral", "greed", "extreme greed"}
    if not isinstance(value, str) or value.casefold().strip() not in allowed:
        raise ValueError("classification is invalid")
    return cast(SentimentClassification, value.casefold().strip())


@dataclass(frozen=True, slots=True)
class SentimentPoint:
    timestamp: datetime
    value: float
    classification: SentimentClassification | None = None

    def to_wire(self) -> dict[str, Any]:
        result: dict[str, Any] = {"timestamp": _iso(self.timestamp), "value": self.value}
        if self.classification is not None:
            result["classification"] = self.classification
        return result

    @classmethod
    def from_wire(cls, value: object) -> SentimentPoint:
        if not isinstance(value, dict):
            raise ValueError("point must be an object")
        raw_value = value.get("value")
        if not isinstance(raw_value, int | float):
            raise ValueError("point value must be numeric")
        classification = value.get("classification")
        return cls(
            timestamp=_datetime(value.get("timestamp"), "point timestamp"),
            value=float(raw_value),
            classification=None if classification is None else _classification(classification),
        )


@dataclass(frozen=True, slots=True)
class SentimentSeries:
    key: str
    label: str
    unit: str
    points: tuple[SentimentPoint, ...]

    def to_wire(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "label": self.label,
            "unit": self.unit,
            "points": [point.to_wire() for point in self.points],
        }

    @classmethod
    def from_wire(cls, value: object) -> SentimentSeries:
        if not isinstance(value, dict) or not isinstance(value.get("points"), list):
            raise ValueError("series must contain points")
        return cls(
            key=str(value.get("key", "")),
            label=str(value.get("label", "")),
            unit=str(value.get("unit", "")),
            points=tuple(SentimentPoint.from_wire(point) for point in value["points"]),
        )


@dataclass(frozen=True, slots=True)
class SentimentMetric:
    key: str
    label: str
    score: float
    classification: SentimentClassification
    timestamp: datetime
    series: tuple[SentimentSeries, ...]

    def to_wire(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "label": self.label,
            "score": self.score,
            "classification": self.classification,
            "timestamp": _iso(self.timestamp),
            "series": [series.to_wire() for series in self.series],
        }

    @classmethod
    def from_wire(cls, value: object) -> SentimentMetric:
        if not isinstance(value, dict) or not isinstance(value.get("series"), list):
            raise ValueError("metric must contain series")
        score = value.get("score")
        if not isinstance(score, int | float):
            raise ValueError("metric score must be numeric")
        return cls(
            key=str(value.get("key", "")),
            label=str(value.get("label", "")),
            score=float(score),
            classification=_classification(value.get("classification")),
            timestamp=_datetime(value.get("timestamp"), "metric timestamp"),
            series=tuple(SentimentSeries.from_wire(series) for series in value["series"]),
        )


@dataclass(frozen=True, slots=True)
class SentimentSnapshot:
    source: SentimentSource
    fetched_at: datetime
    as_of: datetime
    composite: SentimentMetric
    indicators: tuple[SentimentMetric, ...]
    stale: bool = False

    def as_stale(self) -> SentimentSnapshot:
        return replace(self, stale=True)

    def to_wire(self) -> dict[str, Any]:
        return {
            "source": self.source,
            "fetchedAt": _iso(self.fetched_at),
            "asOf": _iso(self.as_of),
            "stale": self.stale,
            "composite": self.composite.to_wire(),
            "indicators": [metric.to_wire() for metric in self.indicators],
        }

    @classmethod
    def from_wire(cls, value: object) -> SentimentSnapshot:
        if not isinstance(value, dict) or not isinstance(value.get("indicators"), list):
            raise ValueError("snapshot must contain indicators")
        source = value.get("source")
        if source not in {"cnn", "cnn-mirror"}:
            raise ValueError("snapshot source is invalid")
        return cls(
            source=cast(SentimentSource, source),
            fetched_at=_datetime(value.get("fetchedAt"), "fetchedAt"),
            as_of=_datetime(value.get("asOf"), "asOf"),
            stale=bool(value.get("stale", False)),
            composite=SentimentMetric.from_wire(value.get("composite")),
            indicators=tuple(SentimentMetric.from_wire(metric) for metric in value["indicators"]),
        )

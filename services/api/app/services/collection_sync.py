"""Bounded replica attempts that only follow complete local Airfare passes."""

import logging
from typing import Protocol

from app.services.airfare_sync import SyncReport
from app.services.fare_collector import CalendarReport, CollectionReport
from app.services.fare_passes import WANTED_AND_REFUSED

logger = logging.getLogger(__name__)

_DATASETS = (
    "snapshots",
    "baseline",
    "calendar",
    "board_checks",
    "calendar_checks",
    "airports",
    "documents",
)


class _AirfareSyncFacade(Protocol):
    def sync_incremental(self) -> SyncReport: ...


def sync_completed_pass(
    data: _AirfareSyncFacade, *reports: CollectionReport | CalendarReport
) -> bool:
    """Attempt one facade-locked sync for a complete local pass, never changing it."""
    if not _is_complete(reports):
        return False
    try:
        sync = data.sync_incremental()
        if sync.status == "complete":
            return True
        logger.warning(
            "Airfare replica sync failed after a completed local pass; uploaded %s",
            _uploaded_counts(sync),
        )
    except Exception as error:  # noqa: BLE001 - sync observability cannot alter a local pass
        logger.warning(
            "Airfare replica sync raised after a completed local pass (%s)", type(error).__name__
        )
    return False


def _is_complete(reports: tuple[CollectionReport | CalendarReport, ...]) -> bool:
    """A no-op, failed, or budget/window-truncated pass has no sync trigger."""
    return (
        bool(reports)
        and any(report.collected > 0 for report in reports)
        and all(
            report.failed == 0
            and not any(reason in WANTED_AND_REFUSED for _, reason in report.skipped)
            for report in reports
        )
    )


def _uploaded_counts(report: SyncReport) -> str:
    """Only fixed dataset names and numeric counts may enter sync failure logs."""
    return ", ".join(f"{name}={report.uploaded.get(name, 0)}" for name in _DATASETS)

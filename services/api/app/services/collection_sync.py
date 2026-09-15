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
    """A complete observation may sync even beside a separately refused calendar."""
    return (
        bool(reports)
        # A single collector's failed result is not a completed observation.
        # The scheduled command combines two independent collectors, though:
        # a healthy board observation still earns one sync when its calendar
        # companion was refused. That companion's heartbeat is persisted before
        # this boundary and rides the same incremental sync.
        and any(report.collected > 0 and report.failed == 0 for report in reports)
        # Budget and pass-window refusals mean a collector was deliberately
        # truncated, so no combined report may claim the pass was complete.
        and not any(
            reason in WANTED_AND_REFUSED for report in reports for _, reason in report.skipped
        )
    )


def _uploaded_counts(report: SyncReport) -> str:
    """Only fixed dataset names and numeric counts may enter sync failure logs."""
    return ", ".join(f"{name}={report.uploaded.get(name, 0)}" for name in _DATASETS)

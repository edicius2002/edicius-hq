"""Deadline pacing keeps the Google request-start invariant measurable."""

import asyncio

from app.services import fare_collector


class Clock:
    def __init__(self) -> None:
        self.now = 0.0
        self.sleeps: list[float] = []

    def monotonic(self) -> float:
        return self.now

    async def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds


def test_deadline_pacer_counts_the_request_time_toward_the_next_gap():
    """A flat sleep would start the second request at 3.63 rather than 3.00."""
    clock = Clock()
    starts: list[float] = []

    async def scenario() -> None:
        pacer = fare_collector.DeadlinePacer(clock=clock.monotonic, sleep=clock.sleep)
        await pacer.wait(gap_seconds=3.0)
        starts.append(clock.now)
        clock.now += 0.63
        await pacer.wait(gap_seconds=3.0)
        starts.append(clock.now)

    asyncio.run(scenario())

    assert starts == [0.0, 3.0]
    assert clock.sleeps == [2.37]

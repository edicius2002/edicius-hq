import asyncio

from app.services.tweet_watcher import TweetWatcher


def test_cycle_persists_only_unknown_ids_and_keeps_a_recent_id_window(tmp_path):
    async def scenario():
        watcher = TweetWatcher(data_dir=tmp_path, cycle=lambda _handle: None)
        watcher._write("sample", [{"id": "old"}, {"id": "new"}])
        captured = await watcher.record("sample", [{"id": "old"}, {"id": "reply-to-old"}])
        assert captured == 1
        assert watcher.recent_ids("sample") == {"old", "new", "reply-to-old"}

    asyncio.run(scenario())


def test_a_failed_cycle_increases_backoff(tmp_path):
    async def scenario():
        async def broken(_handle):
            raise RuntimeError("challenge")

        watcher = TweetWatcher(data_dir=tmp_path, cycle=broken, jitter=lambda _a, _b: 0)
        await watcher.run_once("sample")
        assert watcher.current("sample").state == "failed"
        assert watcher.delay_seconds == 240

    asyncio.run(scenario())


def test_manual_refresh_uses_the_watchers_single_running_cycle(tmp_path):
    async def scenario():
        started = asyncio.Event()
        release = asyncio.Event()

        async def cycle(_handle):
            started.set()
            await release.wait()
            return []

        watcher = TweetWatcher(data_dir=tmp_path, cycle=cycle)
        first = watcher.refresh("sample")
        await started.wait()
        second = watcher.refresh("sample")
        assert second is first
        release.set()
        await watcher.task

    asyncio.run(scenario())

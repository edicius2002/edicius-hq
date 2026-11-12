import io
import sys
import zipfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import preview_worker as worker

PDF = b"%PDF-1.7\nexample"


def archive(entries):
    data = io.BytesIO()
    with zipfile.ZipFile(data, "w") as out:
        for name, content in entries:
            out.writestr(name, content)
    return data.getvalue()


def test_multiple_pdfs_are_preserved_and_non_pdf_is_not_extracted():
    data = archive(
        [("first.pdf", PDF), ("folder/second.pdf", PDF), ("extra.rar", b"rar")]
    )
    assert worker.pdf_members(data) == [("first.pdf", PDF), ("second.pdf", PDF)]


def test_pdf_member_names_remove_del():
    assert worker.pdf_members(archive([("a\x7fb.pdf", PDF)]))[0][0] == "ab.pdf"


@pytest.mark.parametrize("name", ["😀" * 110 + ".pdf", "a" + "😀" * 110 + ".pdf"])
def test_pdf_member_names_fit_javascript_utf16_limit(name):
    sanitized = worker.pdf_members(archive([(name, PDF)]))[0][0]
    assert len(sanitized.encode("utf-16-le")) <= 400
    assert sanitized == ("😀" * 100 if name.startswith("😀") else "a" + "😀" * 99)


@pytest.mark.parametrize(
    "entries",
    [
        [("../bad.pdf", PDF)],
        [("C:\\bad.pdf", PDF)],
        [("fake.pdf", b"not pdf")],
        [("nested.zip", b"zip")],
        [(f"{i}.pdf", PDF) for i in range(6)],
        [("safe.pdf", PDF), ("../other.rar", b"rar")],
    ],
)
def test_rejects_unsafe_or_unsupported_archives(entries):
    with pytest.raises(worker.PermanentError):
        worker.pdf_members(archive(entries))


def test_bounded_expansion(monkeypatch):
    monkeypatch.setattr(worker, "MAX_EXPANDED", 10)
    with pytest.raises(worker.PermanentError):
        worker.pdf_members(archive([("large.pdf", PDF)]))


@pytest.mark.parametrize(
    "source",
    [
        "https://prod6.seace.gob.pe.evil.test/1",
        "http://prod4.seace.gob.pe:9000/api/con/documentos/descargar/1",
        "https://prod4.seace.gob.pe:9000/api/con/documentos/descargar/1?next=x",
    ],
)
def test_rejects_sources_before_network(source):
    with pytest.raises(worker.PermanentError):
        worker.source_url(source)


def make_worker(monkeypatch, data=PDF, upload_error=False):
    instance = worker.Worker("https://example.vercel.app", "test-key")
    calls = []
    job = {
        "job": {
            "id": "opaque",
            "kind": "url",
            "source": "https://prod4.seace.gob.pe:9000/api/con/documentos/descargar/1",
        },
        "receiptHandle": "receipt",
        "leaseToken": "lease",
    }

    def api(payload=None):
        calls.append(payload)
        if payload is None:
            return job
        if payload["action"] == "upload":
            return {
                "uploadUrl": "https://store.private.blob.vercel-storage.com/file?signature=x"
            }
        return {"acknowledged": True}

    def fetch(url, **kwargs):
        if kwargs.get("method") == "PUT":
            if upload_error:
                raise TimeoutError("signed URL must not be logged")
            return b"{}"
        return data

    monkeypatch.setattr(instance, "api", api)
    monkeypatch.setattr(worker, "request_bytes", fetch)
    return instance, calls


def test_uploads_every_pdf_before_completion(monkeypatch):
    instance, calls = make_worker(
        monkeypatch, archive([("one.pdf", PDF), ("two.pdf", PDF)])
    )
    assert instance.once()
    assert [c["action"] for c in calls[1:]] == ["upload", "upload", "complete"]
    assert calls[-1]["status"] == "ready"
    assert [f["index"] for f in calls[-1]["files"]] == [0, 1]
    assert all(c["leaseToken"] == "lease" for c in calls[1:])


def test_upload_failure_does_not_acknowledge(monkeypatch):
    instance, calls = make_worker(monkeypatch, upload_error=True)
    with pytest.raises(TimeoutError):
        instance.once()
    assert not any(c and c["action"] == "complete" for c in calls)


def test_unsupported_acknowledges_without_upload(monkeypatch):
    instance, calls = make_worker(monkeypatch, b"RAR")
    instance.once()
    assert calls[-1]["status"] == "unsupported"
    assert len(calls) == 2


def test_redirects_are_never_followed():
    assert (
        worker.NoRedirect().redirect_request(
            None, None, 302, "", {}, "https://evil.test"
        )
        is None
    )


def test_redelivery_skips_verified_upload_and_completes(monkeypatch):
    instance, calls = make_worker(monkeypatch)
    original_api = instance.api

    def api(payload=None):
        result = original_api(payload)
        return (
            {"alreadyUploaded": True}
            if payload and payload["action"] == "upload"
            else result
        )

    monkeypatch.setattr(instance, "api", api)
    assert instance.once()
    assert calls[-1]["status"] == "ready"


def test_process_resolver_cannot_return_an_external_origin(monkeypatch):
    monkeypatch.setattr(
        worker,
        "request_bytes",
        lambda *a, **kw: (
            b'callback({"result":200,"downloadUrl":"https://evil.test/a"});'
        ),
    )
    with pytest.raises(RuntimeError):
        worker.process_url("12345678-1234-1234-1234-123456789abc")


def test_download_enforces_stream_limit_without_content_length(monkeypatch):
    monkeypatch.setattr(worker, "JOB_DEADLINE", None)

    class Response(io.BytesIO):
        status = 200

        @property
        def headers(self):
            return {}

    monkeypatch.setattr(worker.OPENER, "open", lambda *a, **kw: Response(b"x" * 11))
    with pytest.raises(worker.PermanentError, match="too-large"):
        worker.request_bytes("https://example.test", limit=10)


def test_expired_job_does_not_start_another_request(monkeypatch):
    monkeypatch.setattr(worker, "JOB_DEADLINE", worker.time.monotonic() - 1)
    with pytest.raises(TimeoutError, match="job-timeout"):
        worker.request_bytes("https://example.test")

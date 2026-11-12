"""Outbound-only, sequential SEACE preview worker. No source URLs enter logs."""

import argparse
import io
import json
import os
import re
import signal
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile

MAX_BYTES = 30 * 1024 * 1024
MAX_EXPANDED = 60 * 1024 * 1024
MAX_PDFS = 5
STOP = False
JOB_DEADLINE = None


class PermanentError(Exception):
    """The document cannot safely be previewed."""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


OPENER = urllib.request.build_opener(NoRedirect)


def request_bytes(
    url, *, data=None, headers=None, method="GET", limit=MAX_BYTES, timeout=50
):
    request = urllib.request.Request(
        url, data=data, headers=headers or {}, method=method
    )
    deadline = min(time.monotonic() + timeout, JOB_DEADLINE or float("inf"))
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError("job-timeout")
    with OPENER.open(request, timeout=remaining) as response:
        if response.status == 204:
            return b""
        length = response.headers.get("Content-Length")
        if length and int(length) > limit:
            raise PermanentError("too-large")
        chunks = []
        size = 0
        while True:
            if time.monotonic() > deadline:
                raise TimeoutError("request-timeout")
            # Refresh the socket timeout against the absolute deadline: a slow
            # peer must not reset a full timeout for every incoming chunk.
            socket = getattr(
                getattr(getattr(response, "fp", None), "raw", None), "_sock", None
            )
            if socket is not None:
                socket.settimeout(max(0.001, deadline - time.monotonic()))
            reader = getattr(response, "read1", response.read)
            chunk = reader(min(65536, limit + 1 - size))
            if not chunk:
                return b"".join(chunks)
            size += len(chunk)
            if size > limit:
                raise PermanentError("too-large")
            chunks.append(chunk)


def source_url(source):
    patterns = (
        r"https://prod4\.seace\.gob\.pe:9000/api/con/documentos/descargar/[0-9]+",
        r"https://prod6\.seace\.gob\.pe/v1/s8uit-services/archivo/archivos-publico/descargar-archivo-contrato/[0-9]+",
    )
    if not isinstance(source, str) or not any(
        re.fullmatch(p, source) for p in patterns
    ):
        raise PermanentError("invalid-source")
    return source


def process_url(source):
    if not isinstance(source, str) or not re.fullmatch(
        r"[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}", source
    ):
        raise PermanentError("invalid-source")
    raw = request_bytes(
        "https://alfprod.seace.gob.pe/alfresco/service/osce/downloadDoc"
        f"?id={source}&doc=c123456&guest=true",
        headers={"User-Agent": "node"},
        limit=65536,
    )
    match = re.search(rb"\(([\s\S]*)\)\s*;?\s*$", raw)
    if not match:
        raise RuntimeError("resolver-response")
    result = json.loads(match.group(1))
    base = {
        "200": "https://alfprod.seace.gob.pe/alfresco",
        "201": "https://prodcont2.seace.gob.pe/alfresco",
    }.get(str(result.get("result")))
    relative = result.get("downloadUrl")
    if not base or not isinstance(relative, str) or not relative.startswith("/"):
        raise RuntimeError("resolver-response")
    url = base + relative
    parsed = urllib.parse.urlsplit(url)
    if (
        parsed.hostname not in {"alfprod.seace.gob.pe", "prodcont2.seace.gob.pe"}
        or parsed.username
        or parsed.password
        or parsed.port
        or parsed.fragment
        or "\\" in url
        or any(ord(c) < 32 for c in url)
    ):
        raise PermanentError("invalid-source")
    return url


def pdf_members(data):
    if data.startswith(b"%PDF-"):
        if len(data) > MAX_BYTES:
            raise PermanentError("too-large")
        return [("document.pdf", data)]
    if not data.startswith(b"PK\x03\x04"):
        raise PermanentError("unsupported")
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            entries = archive.infolist()
            if len(entries) > 20 or sum(e.file_size for e in entries) > MAX_EXPANDED:
                raise PermanentError("unsafe-archive")
            files = []
            for entry in entries:
                path = entry.filename.replace("\\", "/")
                if (
                    entry.flag_bits & 1
                    or path.startswith("/")
                    or ":" in path
                    or ".." in path.split("/")
                    or "\x00" in path
                    or (entry.external_attr >> 16) & 0o170000 == 0o120000
                    or entry.file_size > MAX_BYTES
                    or (
                        entry.file_size
                        and (
                            not entry.compress_size
                            or entry.file_size / entry.compress_size > 100
                        )
                    )
                ):
                    raise PermanentError("unsafe-archive")
                if entry.is_dir() or not path.lower().endswith(".pdf"):
                    continue
                if len(files) >= MAX_PDFS:
                    raise PermanentError("unsafe-archive")
                with archive.open(entry) as stream:
                    pdf = stream.read(MAX_BYTES + 1)
                if len(pdf) > MAX_BYTES or not pdf.startswith(b"%PDF-"):
                    raise PermanentError("unsupported")
                name = path.rsplit("/", 1)[-1]
                name = "".join(c for c in name if ord(c) >= 32 and ord(c) != 127)
                # The API's JavaScript length limit counts UTF-16 code units.
                # Ignore a trailing split surrogate rather than emitting it.
                name = name.encode("utf-16-le")[:400].decode(
                    "utf-16-le", errors="ignore"
                )
                files.append((name, pdf))
            if not files:
                raise PermanentError("unsupported")
            return files
    except (zipfile.BadZipFile, NotImplementedError, RuntimeError) as error:
        raise PermanentError("unsafe-archive") from error


class Worker:
    def __init__(self, base_url, key):
        parsed = urllib.parse.urlsplit(base_url)
        if (
            parsed.scheme != "https"
            or not parsed.hostname
            or parsed.username
            or parsed.password
            or parsed.query
            or parsed.fragment
            or parsed.path not in ("", "/")
            or not key
        ):
            raise ValueError("invalid-worker-configuration")
        self.endpoint = base_url.rstrip("/") + "/api/seace/preview-worker"
        self.key = key

    def api(self, payload=None):
        raw = request_bytes(
            self.endpoint,
            method="GET" if payload is None else "POST",
            data=None if payload is None else json.dumps(payload).encode(),
            headers={
                "Authorization": f"Bearer {self.key}",
                "Content-Type": "application/json",
            },
            limit=128 * 1024,
            timeout=35,
        )
        return json.loads(raw) if raw else None

    def once(self):
        global JOB_DEADLINE
        JOB_DEADLINE = None
        work = self.api()
        if not work:
            return False
        JOB_DEADLINE = time.monotonic() + 540
        job = work["job"]
        identity = {
            "jobId": job["id"],
            "receiptHandle": work["receiptHandle"],
            "leaseToken": work["leaseToken"],
        }
        try:
            if job["kind"] == "url":
                url = source_url(job["source"])
            elif job["kind"] == "process":
                url = process_url(job["source"])
            else:
                raise PermanentError("invalid-source")
            files = pdf_members(request_bytes(url, headers={"User-Agent": "node"}))
        except PermanentError as error:
            status = "failed" if str(error) == "invalid-source" else "unsupported"
            self.api({**identity, "action": "complete", "status": status})
            print(f"SEACE_PREVIEW_DONE status={status}", flush=True)
            return True
        members = []
        for index, (name, pdf) in enumerate(files):
            member = {"index": index, "name": name, "size": len(pdf)}
            upload = self.api({**identity, "action": "upload", "member": member})
            if upload.get("alreadyUploaded") is True:
                members.append(member)
                continue
            upload_url = upload["uploadUrl"]
            parsed = urllib.parse.urlsplit(upload_url)
            if (
                parsed.scheme != "https"
                or not parsed.hostname
                or not parsed.hostname.endswith(".blob.vercel-storage.com")
                or parsed.username
                or parsed.password
                or parsed.port
            ):
                raise RuntimeError("invalid-upload-target")
            request_bytes(
                upload_url,
                data=pdf,
                method="PUT",
                headers={"Content-Type": "application/pdf"},
                timeout=90,
                limit=128 * 1024,
            )
            members.append(member)
        self.api(
            {**identity, "action": "complete", "status": "ready", "files": members}
        )
        print(f"SEACE_PREVIEW_DONE status=ready files={len(members)}", flush=True)
        return True


def stop(_signum, _frame):
    global STOP
    STOP = True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    try:
        worker = Worker(
            os.environ.get("SEACE_PREVIEW_BASE_URL", ""),
            os.environ.get("SEACE_PREVIEW_WORKER_KEY", ""),
        )
        interval = max(
            10, min(60, int(os.environ.get("SEACE_PREVIEW_POLL_SECONDS", "10")))
        )
    except ValueError:
        parser.exit(2, "Invalid SEACE preview worker configuration\n")
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    failures = 0
    while not STOP:
        try:
            busy = worker.once()
            failures = 0
        except Exception:  # noqa: BLE001 - retry leases without logging credential-bearing errors.
            print("SEACE_PREVIEW_RETRY", flush=True)
            busy = False
            failures += 1
            if args.once:
                return 1
        if args.once:
            return 0
        delay = 0 if busy else min(60, interval * 2 ** min(failures, 3))
        for _ in range(delay):
            if STOP:
                break
            time.sleep(1)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

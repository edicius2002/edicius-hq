"""THROWAWAY SPIKE: consume one SEACE preview job from a Vercel Preview deployment."""

import argparse
import io
import json
import re
import subprocess
import urllib.request
import zipfile

MAX_BYTES = 30 * 1024 * 1024


def api(url, key, bypass, method="GET", data=None):
    body = None if data is None else json.dumps(data).encode()
    request = urllib.request.Request(
        url,
        data=body,
        method=method,
        headers={
            "X-Spike-Key": key,
            "x-vercel-protection-bypass": bypass,
            **({"Content-Type": "application/json"} if body else {}),
        },
    )
    with urllib.request.urlopen(request, timeout=35) as response:
        if response.status == 204:
            return None
        return json.load(response)


def curl_bytes(url):
    result = subprocess.run(
        ["curl", "--silent", "--show-error", "--fail", "--max-time", "50", "--max-filesize", str(MAX_BYTES), "-A", "node", url],
        capture_output=True,
        check=False,
    )
    if result.returncode or len(result.stdout) > MAX_BYTES:
        raise RuntimeError(f"SEACE fetch failed (curl exit {result.returncode})")
    return result.stdout


def process_url(uuid):
    if not re.fullmatch(r"[0-9a-fA-F-]{36}", uuid):
        raise ValueError("Invalid process UUID")
    response = curl_bytes(
        f"https://alfprod.seace.gob.pe/alfresco/service/osce/downloadDoc?id={uuid}&doc=c123456&guest=true"
    ).decode()
    match = re.search(r"\(([\s\S]*)\)\s*;", response)
    if not match:
        raise RuntimeError("Invalid Alfresco response")
    result = json.loads(match.group(1))
    base = {
        "200": "https://alfprod.seace.gob.pe/alfresco",
        "201": "https://prodcont2.seace.gob.pe/alfresco",
    }.get(str(result.get("result")))
    relative = result.get("downloadUrl", "")
    if not base or not isinstance(relative, str) or not relative.startswith("/"):
        raise RuntimeError("Alfresco did not resolve the document")
    return base + relative


def pdf_from_job(job):
    kind, source = job["kind"], job["source"]
    if kind == "prod6":
        if not re.fullmatch(
            r"https://prod6\.seace\.gob\.pe/v1/s8uit-services/archivo/archivos-publico/descargar-archivo-contrato/[0-9]+",
            source,
        ):
            raise ValueError("Invalid prod6 source")
        data = curl_bytes(source)
    elif kind == "process":
        data = curl_bytes(process_url(source))
    else:
        raise ValueError("Invalid job kind")
    if data.startswith(b"%PDF-"):
        return data, "pdf"
    if not data.startswith(b"PK\x03\x04"):
        raise RuntimeError("Unsupported document type")
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        entries = archive.infolist()
        if len(entries) > 20:
            raise RuntimeError("ZIP has too many entries")
        for entry in entries:
            if entry.is_dir() or not entry.filename.lower().endswith(".pdf"):
                continue
            if (
                entry.flag_bits & 1
                or entry.filename.startswith("/")
                or ".." in entry.filename.replace("\\", "/").split("/")
                or entry.file_size > MAX_BYTES
                or entry.compress_size == 0
                or entry.file_size / entry.compress_size > 100
            ):
                raise RuntimeError("Unsafe ZIP entry")
            with archive.open(entry) as content:
                pdf = content.read(MAX_BYTES + 1)
            if len(pdf) <= MAX_BYTES and pdf.startswith(b"%PDF-"):
                return pdf, "zip-pdf"
    raise RuntimeError("ZIP has no safe PDF")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("base_url")
    parser.add_argument("key_file")
    parser.add_argument("bypass_file")
    args = parser.parse_args()
    key = open(args.key_file, encoding="utf-8").read().strip()
    bypass = open(args.bypass_file, encoding="utf-8").read().strip()
    base = args.base_url.rstrip("/")
    work = api(f"{base}/api/seace/spike?action=work", key, bypass)
    if work is None:
        print("WORK_EMPTY")
        return
    pdf, source_type = pdf_from_job(work["job"])
    upload = urllib.request.Request(
        work["uploadUrl"], data=pdf, method="PUT", headers={"Content-Type": "application/pdf"}
    )
    with urllib.request.urlopen(upload, timeout=90) as response:
        if response.status not in (200, 201):
            raise RuntimeError(f"Blob upload failed: {response.status}")
    ack = api(
        f"{base}/api/seace/spike?action=ack",
        key,
        bypass,
        "POST",
        {"id": work["job"]["id"], "receiptHandle": work["receiptHandle"]},
    )
    if not ack.get("acknowledged"):
        raise RuntimeError("Queue acknowledgement failed")
    print(f"WORK_DONE type={source_type} pdf_bytes={len(pdf)}")


if __name__ == "__main__":
    main()

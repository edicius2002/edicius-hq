const MAX_PDF_BYTES = 20 * 1024 * 1024;

export function allowedDocumentUrl(candidate: string): boolean {
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
      return false;
    return (
      (url.hostname === 'prod4.seace.gob.pe' &&
        url.port === '9000' &&
        /^\/api\/con\/documentos\/descargar\/[0-9]+$/.test(url.pathname)) ||
      (url.hostname === 'prod6.seace.gob.pe' &&
        !url.port &&
        /^\/v1\/s8uit-services\/archivo\/archivos-publico\/descargar-archivo-contrato\/[0-9]+$/.test(
          url.pathname,
        ))
    );
  } catch {
    return false;
  }
}

function pdfHeaders(url: URL): HeadersInit {
  if (url.hostname !== 'prod6.seace.gob.pe') return { Accept: 'application/pdf' };
  return {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'es-PE,es;q=0.9',
    Referer: 'https://prod6.seace.gob.pe/buscador-publico/',
  };
}

function logProxyFailure(host: string, category: string, detail?: string | number): void {
  if (process.env.VERCEL) console.warn('SEACE PDF proxy', { host, category, detail });
}

export async function proxySeaceDocument(
  candidate: string | null,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  if (!candidate || !allowedDocumentUrl(candidate))
    return new Response('Unsupported SEACE document URL', { status: 400 });

  const host = new URL(candidate).hostname;

  let upstream: Response;
  try {
    upstream = await fetcher(candidate, {
      headers: pdfHeaders(new URL(candidate)),
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    const cause =
      error instanceof Error ? (error.cause as { code?: unknown } | undefined) : undefined;
    const code =
      typeof cause?.code === 'string' && /^[A-Z0-9_]+$/.test(cause.code)
        ? cause.code
        : 'fetch-error';
    logProxyFailure(host, 'fetch', code);
    return new Response('SEACE document unavailable', { status: 502 });
  }
  if (upstream.status !== 200 || !upstream.body) {
    logProxyFailure(host, 'status', upstream.status);
    return new Response('SEACE document unavailable', { status: 502 });
  }

  const declaredSize = Number(upstream.headers.get('Content-Length'));
  if (declaredSize > MAX_PDF_BYTES)
    return new Response('SEACE document is too large to preview', { status: 413 });

  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = upstream.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_PDF_BYTES)
        return new Response('SEACE document is too large to preview', { status: 413 });
      chunks.push(value);
      if (size >= 5 && chunks[0]?.byteLength >= 5) {
        const prefix = new TextDecoder().decode(chunks[0].subarray(0, 5));
        if (prefix !== '%PDF-') {
          logProxyFailure(host, 'invalid-pdf');
          return new Response('SEACE did not return a PDF', { status: 502 });
        }
      }
    }
  } catch {
    logProxyFailure(host, 'read');
    return new Response('SEACE document unavailable', { status: 502 });
  } finally {
    await reader.cancel().catch(() => {});
  }

  const prefix = new Uint8Array(Math.min(size, 5));
  let copied = 0;
  for (const chunk of chunks) {
    const length = Math.min(chunk.byteLength, prefix.byteLength - copied);
    prefix.set(chunk.subarray(0, length), copied);
    copied += length;
    if (copied === prefix.byteLength) break;
  }
  if (new TextDecoder().decode(prefix) !== '%PDF-') {
    logProxyFailure(host, 'invalid-pdf');
    return new Response('SEACE did not return a PDF', { status: 502 });
  }

  let next = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (next === chunks.length) controller.close();
        else controller.enqueue(chunks[next++]);
      },
    }),
    {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'inline',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    },
  );
}

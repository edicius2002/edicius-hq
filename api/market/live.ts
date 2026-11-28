import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { Client } from 'pg';

const symbolPattern = /^[A-Z0-9.^=/_:-]{1,64}$/;
const frames = new Set(['1m', '5m', '15m', '1h', '1d', '1w', '1M']);
const encoder = new TextEncoder();

function seal(topic: string, value: object, key: Buffer): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(topic));
  return Buffer.concat([
    nonce,
    cipher.update(JSON.stringify(value)),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString('base64');
}

function unseal(topic: string, payload: string, key: Buffer) {
  const raw = Buffer.from(payload, 'base64');
  const cipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  cipher.setAAD(Buffer.from(topic));
  cipher.setAuthTag(raw.subarray(-16));
  return JSON.parse(
    Buffer.concat([cipher.update(raw.subarray(12, -16)), cipher.final()]).toString(),
  );
}

export async function streamMarket(
  request: Request,
  owner: string,
  databaseUrl: string,
  key: Buffer,
): Promise<Response> {
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(owner))
    return new Response(null, { status: 403 });
  const params = new URL(request.url).searchParams;
  const symbols = (params.get('symbols') ?? '').split(',');
  if (symbols.length > 64 || !symbols.every((s) => symbolPattern.test(s)))
    return new Response(null, { status: 400 });
  const symbol = params.get('symbol');
  const frame = params.get('frame');
  if ((symbol || frame) && !(symbol && symbols.includes(symbol) && frame && frames.has(frame)))
    return new Response(null, { status: 400 });
  const direct = new URL(databaseUrl);
  if (direct.hostname.endsWith('.neon.tech'))
    direct.hostname = direct.hostname.replace(/-pooler\./, '.');
  const db = new Client({
    connectionString: direct.href,
    connectionTimeoutMillis: 8000,
    query_timeout: 8000,
  });
  const suffix = owner.toLowerCase().replaceAll('-', '');
  const data = 'market_data_' + suffix;
  const control = 'market_control_' + suffix;
  const client = randomUUID();
  const wanted = new Set(symbols);
  const lease = (visible: string[]) =>
    db.query('SELECT pg_notify($1,$2)', [
      control,
      seal(
        control,
        {
          client,
          at: Date.now() / 1000,
          symbols: visible,
          symbol,
          frame,
        },
        key,
      ),
    ]);
  let closed = false;
  let listening = false;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    request.signal.removeEventListener('abort', close);
    controller?.close();
    void (async () => {
      try {
        if (listening) await lease([]);
      } catch {
        /* Pi leases also expire. */
      } finally {
        await db.end().catch(() => {});
      }
    })();
  };
  db.on('error', close);
  try {
    await db.connect();
    const allowed = await db.query('SELECT 1 FROM public.edicius_owners WHERE owner_id=$1::uuid', [
      owner,
    ]);
    if (!allowed.rowCount) {
      close();
      return new Response(null, { status: 403 });
    }
    await db.query('LISTEN ' + data);
    listening = true;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
        let lastAck = Date.now();
        const opened = lastAck;
        let ready = false;
        function emit(event: string, value: unknown) {
          if ((c.desiredSize ?? 0) < -16) return close();
          c.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`));
        }
        db.on('notification', (note) => {
          if (closed || note.channel !== data || !note.payload) return;
          try {
            const message = unseal(data, note.payload, key);
            if (message.ready?.includes(client)) {
              lastAck = Date.now();
              if (!ready) emit('ready', {});
              ready = true;
            }
            for (const kind of ['ticks', 'bars']) {
              if (!Array.isArray(message[kind])) continue;
              const values = message[kind].filter((row: { symbol: string; timeframe?: string }) =>
                kind === 'ticks'
                  ? wanted.has(row.symbol)
                  : row.symbol === symbol && row.timeframe === frame,
              );
              if (values.length) emit(kind, values);
            }
          } catch {
            /* Ignore unrelated or unauthenticated packets. */
          }
        });
        request.signal.addEventListener('abort', close, { once: true });
        if (request.signal.aborted || closed) return close();
        c.enqueue(encoder.encode(': connected\n\n'));
        void lease(symbols).catch(close);
        timer = setInterval(() => {
          if (Date.now() - lastAck > 26_000 || Date.now() - opened > 220_000) return close();
          c.enqueue(encoder.encode(': heartbeat\n\n'));
          void lease(symbols).catch(close);
        }, 10_000);
      },
      cancel() {
        controller = undefined;
        close();
      },
    });
    return new Response(body, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'private, no-store, no-transform',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch {
    close();
    return new Response(null, { status: 503 });
  }
}

export async function GET(request: Request): Promise<Response> {
  if (!request.headers.has('cookie')) return new Response(null, { status: 401 });
  const { auth } = await import('../auth.js');
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return new Response(null, { status: 401 });
  const key = Buffer.from(process.env.MARKET_LIVE_KEY ?? '', 'base64');
  if (key.length !== 32 || !process.env.DATABASE_URL) return new Response(null, { status: 503 });
  return streamMarket(request, session.user.id, process.env.DATABASE_URL, key);
}

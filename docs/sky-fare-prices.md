# Why SKY Airline fares arrive unpriced, and what would fix it

- **Status:** experiment complete; no Google Flights RPC change
- **Date:** 2026-09-01
- **Code:** `services/api/app/adapters/fares/google_flights.py`, `services/api/app/adapters/fares/sky_airline.py`
- **Evidence:** `services/api/.local-data/fares/*.jsonl`, 2,340 captured boards containing H2 itineraries

SKY Airline (`H2`) itineraries are archived with `price: null` almost every
time, while the same flights show a fare on the Google Flights page a person
opens in a browser. This note records what was measured, what it rules out, and
why the direct Google Flights RPC is not worth adding. Nothing here has been
implemented.

## The parser is not the problem

Google carries an itinerary's fare at position 1, in two slots that are two
different sources for the same number:

```
itinerary[1] = [ [null, 420]         , "CjRIdmZuRmF1…8HXD4YQ==" ]
                 └─ the integer ─┘     └── protobuf token, field 3 ──┘
                 the page prints       carries the fare to the cent
```

Decoded, on one board, same search:

```
LATAM 2102 → {1: <search-id>, 2: b'LA2102', 3: {1: 12536, 2: 2, 3: b'USD'}, 7: 29, 14: 12536}
SKY   5104 → {1: <search-id>, 2: b'H25104',                                 7: 29}
```

Field 3 is `{units, decimals, currency}` — `12536 / 10²` is 125.36 USD. Field 1
is the search id, identical across every itinerary on the board; field 2
identifies the flight.

Four shapes have been observed:

| Shape                | `itinerary[1]`             | Token field 3 | Stored                     |
| -------------------- | -------------------------- | ------------- | -------------------------- |
| Priced, exact        | `[[null, 420], "<token>"]` | yes           | 419.88 via `_exact_price`  |
| Priced, rounded only | `[[null, 263], "<token>"]` | no            | 263 via `price_node[0][1]` |
| Unpriced             | `[[], "<token>"]`          | no            | `null`                     |

The unpriced shape also carries `[3]==0, [4]==[], [5]==[], [9]==[[1]]`, which is
the signature `_is_explicitly_unpriced` matches. `_offer` resolves the three in
that order — token, then the unpriced signature, then the rounded integer — so
the parser reads all of them without knowing which it will be handed.

**When Google withholds a SKY fare it withholds both slots.** The integer is not
a fallback that is always present. All three of the priced observations in the
archive carried field 3, which is why they are stored with cents (37.23, 55.59,
69.03) rather than as whole numbers.

## What the archive says about the intermittency

2,340 captured boards contain 6,422 H2 observations. **Thirteen carry a
fare** — **0.20%**. This replaces the earlier 336-board / 0.9% snapshot: it was
useful for identifying the intermittency, but is not the comparison baseline
for the RPC experiment below.

The decisive run is 2026-08-28T00h: 122 searches, one every two to three
seconds, same `httpx` client, same cookies, same user-agent, no browser
anywhere:

```
  93. 00:31:07  AQP-LIM 2026-12-02  H2 0/4
  94. 00:31:09  AQP-LIM 2026-12-03  H2 0/4
  95. 00:31:12  AQP-LIM 2026-12-04  H2 0/4
  96. 00:31:14  AQP-LIM 2026-12-05  H2 4/4   ← the only hit in 122
  97. 00:31:17  AQP-LIM 2026-12-06  H2 0/4
  98. 00:31:19  AQP-LIM 2026-12-07  H2 0/4
```

One search in the middle of a run returned fares while its neighbours, three
seconds either side, did not. That rules out every client-level explanation,
because every client-level property was constant across all 122:

- **not** TLS/HTTP2 fingerprinting
- **not** rate limiting — that is progressive or global, not a single hit at #96
- **not** cookie warmth
- **not** headless versus headed — these requests used no browser at all, and
  one of them worked

The variable is the search, not the caller.

## The mechanism, and a red herring

The reading that fits every observation: Google does not price SKY while
serving the HTML, it reads a cached answer. On a hit the payload carries the
fare; on a miss it renders the itinerary unpriced rather than blocking, and the
page fetches the fare afterwards — the "Loading results" state a person sees
before the SKY rows fill in. The browser always shows a price because the
browser is what triggers the fill.

This also explains an episode that was first read as evidence for headed
browsers. A person opened AQP-LIM 2026-11-11 in a browser; shortly afterwards
four probes of **that same search** — plain httpx, httpx with warmed cookies,
headless Chromium, headed Chromium under Xvfb — all returned the four fares,
and on immediate repetition all four returned `null`. Four consecutive hits
against a 0.9% base rate is not luck; it is a cache entry that the browser
visit had just populated, expiring. Headless versus headed was never the
variable.

## Already ruled out

- **Currency and market.** `hl=en&curr=usd` (what we send), `hl=en&curr=usd&gl=pe`,
  `hl=es&curr=pen&gl=pe` and `hl=en&curr=pen` all returned 16/16 non-SKY
  itineraries priced and 4/4 H2 `null` for the same search.
- **The data island.** The page ships `ds:0`..`ds:4` (`HKwllf`, `LqxFAb`,
  `j0jL5`, `kecaDd`, `Xn8yoc`); we parse `ds:1`. The SKY amounts appear in none
  of the five, and `batchexecute` appears zero times in the served HTML. We are
  not reading the wrong island — on a miss the number is not in the document.
- **Headers and cookies.** A bisect over full Chrome headers, client hints and a
  warmed cookie jar produced no stable minimum. It could not have: it was
  measuring whether the _initial HTML_ carried the fare, which is exactly the
  thing that depends on the cache.

## The `GetShoppingResults` experiment (2026-09-01)

Target the follow-up the browser makes — a POST to `GetShoppingResults`, which
was observed once to return the full board with the same priced nodes. The
question was whether calling it directly made SKY pricing more likely than the
archive's 0.20% rate.

### What was requested

`AQP-LIM` on `2026-11-08` served HTTP 200 HTML with four H2 rows, all `null`.
The target was H2 5104: its token contained the shared ASCII search id in
protobuf field 1 and `b"H25104"` in field 2; like the other H2 tokens, it had
only fields 1, 2 and 7, with no price field 3.

The request was a form POST to the direct RPC path:

```
/_/FlightsFrontendUi/data/
travel.frontend.flights.FlightsFrontendService/GetShoppingResults
```

with `hl=en`, `gl=us`, `curr=USD`, `CALENDAR_HEADERS`, and an `f.req` of the
same `[null, "<nested JSON>"]` form used by the calendar RPC. Its inner search
was the one-way AQP-LIM / 2026-11-08 economy search for one adult; no cookies
or session were sent. The attempted selected-segment encoding
`segment[8] = [[search_id, "H25104"]]` was not a valid contract: it returned
HTTP 200 with one `wrb.fr` frame containing gRPC status 3 (`INVALID_ARGUMENT`)
and no payload. It was therefore not repeated or counted as a price attempt.

Without that invalid selection, the same direct RPC answered the full board.
Twenty valid POSTs, spaced 2.5 seconds apart, all returned HTTP 200, the
`)]}'` guard, and one or two `wrb.fr` payload frames. Every occurrence of
`H25104` in those payloads still had no exact-price field: **0 priced responses
out of 20 (0.00%)**, versus the 0.20% H2 archive baseline.

### Decision

**Failure — do not implement an extra RPC.** A syntactically valid direct
shopping POST did not improve the rate, and the only tested placement for the
search-id / flight-id pair was rejected rather than returning an unpriced
board. Adding a second request would spend traffic, preserve the existing
`null`, and increase failure surface without increasing price coverage. The
parser remains unchanged: its `null` is the faithful answer for this payload.

## If skyairline.com becomes the route

`sky_airline.py` exists for this and has never run. It is opt-in behind
`SKY_OFFICIAL_LOOKUP_ENABLED`, which is set nowhere — not in `.env.example`, not
in `docker-compose.yml` — and its selectors are declared provisional in the
module's own header. Fail-closed means a live page that satisfies none of them
returns a safe unpriced result, which is what it would do today.

What would have to change:

| What               | Where                                | Work                                                                                                                                             |
| ------------------ | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| ~15 selectors      | `sky_airline.py:27-48`               | All placeholders. Capture the real ones.                                                                                                         |
| Per-card tax proof | `_parse_result_row`                  | Requires `is_checked` on each card. If SKY only states tax inclusion page-wide, this rejects everything and the rule needs an explicit decision. |
| Itinerary matching | `_matches`                           | Exact equality on flight number, departure, arrival, via points, transfers and duration. SKY's formats are not Google's ISO `2026-11-11T06:50`.  |
| USD switch         | `LOCALE_MENU_SELECTOR`               | Same placeholder problem.                                                                                                                        |
| Activation         | `.env.example`, `docker-compose.yml` | The flag has no home yet.                                                                                                                        |

The standing cost is one browser session per query, against a collector that
sweeps many routes and dates.

## What must not change

`google_flights.py`. The `null` it produces is faithful to the payload, and
`_is_explicitly_unpriced` matches a real, verified signature — see the captured
board in `services/api/tests/fixtures/google_flights_all_unpriced_payload.json`.

## Reconocimiento de la disponibilidad pública de SKY (2026-09-01)

### Decisión

No implementar todavía un adapter `httpx` de producción. La página pública expone
un endpoint JSON que se puede consultar con HTTP plano, pero su payload es una
tarifa de ruta/fecha sin número de vuelo, horas, duración, escalas ni declaración
de impuestos. Por eso no permite satisfacer `_matches` ni la prueba de impuestos
incluidos de `sky_airline.py`. El siguiente experimento, si se justifica, debe ser
Playwright contra el flujo de búsqueda público con selectores reales; no login,
reserva, pago ni CAPTCHA.

### Request reproducido

La configuración pública de `https://www.skyairline.com/flights/en/` publica,
para el tenant `h2`, este contrato:

- `POST https://openair-california.airtrfx.com/airfare-sputnik-service/v3/h2/fares/search`
- Headers: `Content-Type: application/json` y el `em-api-key` público leído de
  esa misma página. La clave rota y no se documenta ni se guarda.
- Body mínimo observado:

```json
{
  "routesLimit": 20,
  "faresLimit": 50,
  "faresPerRoute": 2,
  "autoSettings": {"language": "en", "market": ""},
  "origins": ["AQP"],
  "destinations": ["LIM"],
  "journeyType": "ONE_WAY",
  "departureDaysInterval": {"start": 65, "end": 65}
}
```

`departureDaysInterval` es relativo a la fecha de consulta; 65 correspondía a
2026-11-05 en esta medición. El spike reproducible es
`scripts/sky-availability-spike.py`; impone una espera mínima de 2,5 s entre la
landing y el POST y no imprime la clave ni cookies.

### Sesión y resultado AQP–LIM

Con un cliente HTTP nuevo para el POST (sin cookies de la landing, token ni
sesión), el request devolvió `200 application/json` desde Cloudflare. Hubo
respuestas iniciales `403` durante el reconocimiento, por lo que el spike siempre
lee la clave pública vigente de la página antes de consultar y reporta el estado.
La corrida exitosa confirma que no hace falta reutilizar cookies de la landing;
la clave publicada por la página sí es el header derivado necesario.

Para AQP–LIM, 2026-11-05 —un board archivado de Google con H2 5102/5104/5118/5116
y `price: null`— el JSON tuvo un resultado H2 con:

```json
{
  "departureDate": "2026-11-05",
  "airline": {"iataCode": "H2"},
  "priceSpecification": {
    "totalPrice": 31,
    "usdTotalPrice": 31,
    "currencyCode": "USD",
    "formattedTotalPrice": "USD 31"
  }
}
```

Esto prueba que HTTP plano puede recuperar una tarifa H2 para la misma ruta y
fecha donde Google la dejó sin precio. No prueba que sea la tarifa de uno de los
cuatro vuelos Google: el endpoint devuelve una tarifa de descubrimiento, no
inventario detallado.

### Moneda, impuestos y match

El payload declara `currencyCode: USD` y llama al valor `totalPrice`, pero no
contiene campo, texto ni desglose que declare impuestos incluidos. No hay base
para relajar la regla por tarjeta de `_parse_result_row`.

`outboundFlight` sólo tiene `departureAirportIataCode`,
`arrivalAirportIataCode`, `fareClass`, `fareClassInput`, `origin` y
`destination`. La fecha es `YYYY-MM-DD`; no trae timestamps ISO, número de
vuelo, via points, transbordos ni duración. Es imposible casar este resultado
con Google bajo `_matches` sin cambiar esa invariancia, así que no debe usarse
para completar precios de observaciones concretas.

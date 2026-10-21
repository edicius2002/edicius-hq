import { formatFlightDate } from '@/features/airfare/data/fareRoutes';

/**
 * A link from a flight on the board to the operating airline's own booking
 * search — never to an aggregator.
 *
 * **It is a route and a date, and it is not this flight.** The exact
 * per-itinerary link does not exist to be built: no booking URL appears
 * anywhere in the provider's payload — the only carrier URLs in it are FAQ and
 * baggage-policy pages — and the one token that does resolve to a booking
 * resolves to a Google-hosted POST redirect, which is both an aggregator hop
 * and a POST, so it could not be an `<a href>` even if the hop were acceptable.
 * The URLs below start a fresh airline search or show a published route page;
 * none is a checkout URL for the observed flight or its archived fare.
 *
 * Where the airline accepts search parameters, the reader gets the route and
 * date and matches the departure time by eye. Published route pages and general
 * search forms are used elsewhere; their names say which details still need
 * to be chosen on the airline's site.
 */

/**
 * Which storefront a carrier's booking engine is opened in.
 *
 * LATAM and JetSMART both need one. LATAM's is in the path — `/pe/es/` — and
 * the path slug after it is localised with the language, so the country and the
 * words are one choice and not two. JetSMART runs Navitaire New Skies on its own
 * host and takes the same choice as a currency and a culture in the query.
 *
 * Aerolíneas Argentinas needs none, which is why it is absent from this type:
 * its search reads one host, in one country, and adding a point of sale to it
 * would be inventing a parameter to keep a shape tidy.
 */
export type PointOfSale = {
  /** LATAM's country segment, lower case. */
  country: string;
  /** LATAM's language segment. */
  language: string;
  /** LATAM's path slug, which is written in that language. */
  offers: string;
  /** JetSMART's currency. */
  currency: string;
  /** And its culture, the other half of a New Skies point of sale. */
  culture: string;
};

/**
 * The three countries the archive actually flies out of, and nothing else.
 *
 * Keyed on the country **name**, because a name is what the provider ships:
 * every airport record carries `country: "Peru"` and the ISO code sitting one
 * field away from it in the upstream payload is not read. Names are matched
 * with their accents stripped and folded to lower case, so `Perú` and `Peru`
 * are the same key and a provider that starts writing one instead of the other
 * does not silently drop every Peruvian link.
 *
 * Deliberately short. Both carriers sell in other countries, but those
 * storefront paths and cultures have not been verified here. An origin outside
 * these three opens the carrier's general site so the reader can choose a
 * point of sale, route and date there.
 */
const POINTS_OF_SALE: Record<string, PointOfSale> = {
  peru: {
    country: 'pe',
    language: 'es',
    offers: 'ofertas-vuelos',
    currency: 'PEN',
    culture: 'es-PE',
  },
  chile: {
    country: 'cl',
    language: 'es',
    offers: 'ofertas-vuelos',
    currency: 'CLP',
    culture: 'es-CL',
  },
  argentina: {
    country: 'ar',
    language: 'es',
    offers: 'ofertas-vuelos',
    currency: 'ARS',
    culture: 'es-AR',
  },
};

/** Accents off, case folded, so one spelling of a country is every spelling. */
function fold(name: string): string {
  return name
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()
    .toLowerCase();
}

/**
 * The storefront for an origin airport's country, or nothing where we have not
 * loaded one.
 *
 * **The origin's country, not the reader's**, and that is the part this gets
 * wrong. Point of sale is really a fact about who is buying — a reader in Lima
 * looking at an SCL→AEP leg is sent to LATAM Chile and quoted in Chilean pesos,
 * when what they would actually have booked is the Peruvian storefront in soles.
 * The app does not know where its reader is and has nothing to ask: there is no
 * account, no locale it trusts, and the browser's own language says which words
 * someone reads rather than which country they buy in. The origin airport is the
 * one country the archive can name for certain, and being on the wrong side of
 * a currency is a smaller error than being on no page at all.
 */
export function pointOfSale(country: string | null | undefined): PointOfSale | null {
  if (typeof country !== 'string' || country.trim() === '') return null;
  return POINTS_OF_SALE[fold(country)] ?? null;
}

/** One flight's row, reduced to the four things a route search is built from. */
export type FlightSearch = {
  /** Marketing carrier, IATA — the code the row prints. */
  airline: string;
  origin: string;
  destination: string;
  /**
   * `YYYY-MM-DD`, the departure date as the airport's own clock writes it.
   *
   * Taken off `departureAt` by string, never through `Date`: that stamp is wall
   * clock with no zone, and reading it in the reader's own offset would send a
   * 00:15 departure out of Lima to the day before.
   */
  date: string;
  /** The origin airport's country, as the archive records it, or null. */
  originCountry: string | null;
};

const IATA = /^[A-Z]{3}$/;
const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

function usable(search: FlightSearch): boolean {
  return (
    IATA.test(search.origin) && IATA.test(search.destination) && CALENDAR_DATE.test(search.date)
  );
}

/**
 * LATAM: one-way, one adult, economy, sorted the way the site sorts by default.
 *
 * The `/{country}/{language}/` segment is mandatory — the site does not resolve
 * the offers path without it — and the slug that follows is written in that
 * language, so `ofertas-vuelos` and `flight-offers` are the same page. The
 * outbound date is an instant at midnight UTC, which is the shape the engine
 * takes rather than a claim about a departure time; the date itself is the
 * airport's own.
 */
function latam(search: FlightSearch, sale: PointOfSale): string {
  const query = new URLSearchParams();
  query.set('origin', search.origin);
  query.set('outbound', `${search.date}T00:00:00.000Z`);
  query.set('destination', search.destination);
  query.set('adt', '1');
  query.set('chd', '0');
  query.set('inf', '0');
  query.set('trip', 'OW');
  query.set('cabin', 'Economy');
  query.set('redemption', 'false');
  query.set('sort', 'RECOMMENDED');
  return `https://www.latamairlines.com/${sale.country}/${sale.language}/${sale.offers}?${query.toString()}`;
}

/**
 * JetSMART: Navitaire New Skies, on `booking.jetsmart.com` rather than on the
 * marketing site.
 *
 * `InternalSelect` is the engine's own deep link into the results step, so the
 * reader lands on the board rather than on a form they have to fill in again.
 * The three booleans are the trip's shape — not a companion fare, not a
 * flexible-month search, not a round trip — and the numbered suffixes are New
 * Skies' way of writing "the first leg".
 */
function jetsmart(search: FlightSearch, sale: PointOfSale): string {
  const query = new URLSearchParams();
  query.set('c', 'false');
  query.set('mon', 'false');
  query.set('r', 'false');
  query.set('cur', sale.currency);
  query.set('culture', sale.culture);
  query.set('dd1', search.date);
  query.set('o1', search.origin);
  query.set('d1', search.destination);
  query.set('ADT', '1');
  query.set('CHD', '0');
  query.set('INF', '0');
  return `https://booking.jetsmart.com/Flight/InternalSelect?${query.toString()}`;
}

/**
 * Aerolíneas Argentinas: the whole leg in one parameter.
 *
 * `leg=AEP-MDZ-20260925` is origin, destination and a compact date, and it is
 * the only carrier here that needs no point of sale — one host, one country,
 * one currency. `flexDates=false` is what keeps the reader on the date they
 * asked about instead of on the cheapest week around it.
 */
function aerolineas(search: FlightSearch): string {
  const query = new URLSearchParams();
  query.set('adt', '1');
  query.set('chd', '0');
  query.set('inf', '0');
  query.set('flexDates', 'false');
  query.set('cabinClass', 'Economy');
  query.set('flightType', 'ONE_WAY');
  query.set('leg', `${search.origin}-${search.destination}-${search.date.replace(/-/g, '')}`);
  return `https://www.aerolineas.com.ar/flights-offers?${query.toString()}`;
}

/**
 * Plus Ultra's selection step accepts the route and departure date. Its Spanish
 * storefront quotes in EUR for both directions of LIM–MAD. It is a fresh search,
 * not a saved fare or a flight-number checkout link.
 */
function plusUltra(search: FlightSearch): string {
  const query = new URLSearchParams();
  query.set('adt1', '1');
  query.set('chd1', '0');
  query.set('currency', 'EUR');
  query.set('departure1', search.date);
  query.set('destination1', search.destination);
  query.set('inf1', '0');
  query.set('origin1', search.origin);
  return `https://www.plusultra.com/es-es/booking/select/?${query.toString()}`;
}

/** Published official route pages. SKY additionally accepts date parameters. */
const ROUTE_PAGES: Record<string, string> = {
  'H2:LIM:CUZ': 'https://www.skyairline.com/flights/es-pe/vuelos-desde-lima-a-cusco',
  'H2:CUZ:LIM': 'https://www.skyairline.com/flights/es-pe/vuelos-desde-cusco-a-lima',
  'H2:LIM:SCL': 'https://www.skyairline.com/flights/es-pe/vuelos-desde-lima-a-santiago',
  'H2:LIM:AQP': 'https://www.skyairline.com/flights/es-pe/vuelos-desde-lima-a-arequipa',
  'H2:SCL:LIM': 'https://www.skyairline.com/flights/es-cl/vuelos-desde-santiago-a-lima',
  'H2:SCL:CUZ': 'https://www.skyairline.com/flights/es-cl/vuelos-desde-santiago-a-cusco',
  'AV:LIM:BOG': 'https://www.avianca.com/us/en/flights-from-lima-to-bogota',
  'AV:LIM:MAD': 'https://www.avianca.com/us/es/vuelos-desde-lima-a-madrid',
  'AV:SCL:MAD': 'https://www.avianca.com/es/es/vuelos-desde-santiago-a-madrid',
  'AV:MAD:SCL': 'https://www.avianca.com/es/es/vuelos-desde-madrid-a-santiago',
  'AV:LIM:SCL': 'https://www.avianca.com/us/es/vuelos-desde-lima-a-santiago',
  'IB:LIM:MAD': 'https://www.iberia.com/pe/vuelos-baratos/Lima-Madrid/',
  'IB:MAD:LIM': 'https://www.iberia.com/es/vuelos-baratos/Madrid-Lima/',
  'IB:SCL:MAD': 'https://www.iberia.com/cl/vuelos-baratos/Santiago-de-Chile-Madrid/',
  'IB:MAD:SCL': 'https://www.iberia.com/es/vuelos-baratos/Madrid-Santiago-de-Chile/',
  'IB:LIM:BCN': 'https://www.iberia.com/pe/vuelos-baratos/Lima-Barcelona/',
  'UX:LIM:MAD': 'https://www.aireuropa.com/es-pe/ofertas-de-vuelos-desde-lima-a-madrid',
  'UX:MAD:LIM': 'https://www.aireuropa.com/es-es/ofertas-de-vuelos-desde-madrid-a-lima',
  'UX:SCL:MAD':
    'https://www.aireuropa.com/es-cl/ofertas-de-vuelos-desde-santiago-de-chile-a-madrid',
  'UX:MAD:SCL':
    'https://www.aireuropa.com/es-es/ofertas-de-vuelos-desde-madrid-a-santiago-de-chile',
  'UX:LIM:BCN': 'https://www.aireuropa.com/es-pe/ofertas-de-vuelos-desde-lima-a-barcelona',
};

function routePage(search: FlightSearch): string | null {
  return ROUTE_PAGES[`${search.airline}:${search.origin}:${search.destination}`] ?? null;
}

/** SKY's flight-search panel accepts these route and date parameters. */
function sky(search: FlightSearch, sale: PointOfSale | null): string {
  const base =
    routePage(search) ??
    `https://www.skyairline.com/flights/${sale === null ? 'es' : `es-${sale.country}`}/`;
  const query = new URLSearchParams();
  query.set('em_o', search.origin);
  query.set('em_d', search.destination);
  query.set('em_dd', search.date);
  query.set('em_jt', 'ONE_WAY');
  query.set('em_pc', '1');
  return `${base}?${query.toString()}`;
}

/** A form or homepage where the reader must choose both route and date. */
const GENERAL_SEARCH_PAGES: Record<string, string> = {
  AV: 'https://www.avianca.com/us/en/',
  IB: 'https://www.iberia.com/pe/buscador-vuelos/',
  UX: 'https://www.aireuropa.com/es-es/',
  LA: 'https://www.latamairlines.com/',
  JA: 'https://www.jetsmart.com/',
};

type OfficialLink = { url: string; detail: 'date' | 'route' | 'form' };

/**
 * The deepest official page we can identify for this carrier and route. A form
 * fallback is still useful, but does not claim the route or date was selected.
 */
function officialLink(search: FlightSearch): OfficialLink | null {
  if (!usable(search)) return null;
  if (search.airline === 'AR') return { url: aerolineas(search), detail: 'date' };
  if (search.airline === 'PU') return { url: plusUltra(search), detail: 'date' };

  const sale = pointOfSale(search.originCountry);
  if (search.airline === 'H2') return { url: sky(search, sale), detail: 'date' };
  const publishedRoute = routePage(search);
  if (publishedRoute !== null) return { url: publishedRoute, detail: 'route' };

  if (sale !== null && search.airline === 'LA') {
    return { url: latam(search, sale), detail: 'date' };
  }
  if (sale !== null && search.airline === 'JA') {
    return { url: jetsmart(search, sale), detail: 'date' };
  }

  const generalSearch = Object.hasOwn(GENERAL_SEARCH_PAGES, search.airline)
    ? GENERAL_SEARCH_PAGES[search.airline]
    : undefined;
  return generalSearch === undefined ? null : { url: generalSearch, detail: 'form' };
}

export function airlineSearchUrl(search: FlightSearch): string | null {
  return officialLink(search)?.url ?? null;
}

/**
 * What the link is called, to a screen reader and to a pointer resting on it.
 *
 * Date-aware destinations name the date. A published route page asks the
 * reader to choose a date; a general form asks for route and date. No label
 * promises the observed flight or its archived fare.
 */
export function searchLabel(search: FlightSearch, airlineName: string | null): string {
  const carrier = airlineName ?? search.airline;
  const detail = officialLink(search)?.detail;
  if (detail === 'route') {
    return `View ${carrier} flights from ${search.origin} to ${search.destination}; choose a departure date on the airline site`;
  }
  if (detail === 'form') {
    return `Open ${carrier} flight search; choose ${search.origin} to ${search.destination} and a departure date on the airline site`;
  }
  return `Search ${carrier} for ${search.origin} to ${search.destination} on ${formatFlightDate(search.date)}`;
}

/**
 * The same name with the flight in front of it, for the link whose *visible*
 * text is the flight number.
 *
 * `AR 1281 — Search Aerolíneas Argentinas for AEP to MDZ on 02/03/2027` is one
 * example. Route pages use the same flight prefix but ask for a date.
 *
 * **The flight is there because the visible label is.** WCAG 2.5.3 asks that a
 * control's accessible name contain the words a reader can see on it, so a
 * speech-input reader can say "click AR 1281" and hit the thing they are
 * pointing at. While the link was a bare `↗` glyph there were no visible words
 * to contain and `searchLabel` alone was correct; now that the number is the
 * anchor, a name with no `AR 1281` in it names a different control from the one
 * on screen.
 *
 * **And it is a label rather than a promise, because of what follows it.** The
 * verb describes the actual destination: searching a carrier for a city pair
 * and date, or viewing a route page and choosing the date. Nothing here says
 * "book AR 1281" — which is the claim this module cannot keep. The flight
 * number is the reader's own place-marker for which row they pressed; the
 * sentence after the dash is what pressing it does. That order matters: read
 * out, it is the flight, a pause, then an honest account of the destination.
 */
export function flightLinkLabel(
  flight: string,
  search: FlightSearch,
  airlineName: string | null,
): string {
  return `${flight} — ${searchLabel(search, airlineName)}`;
}

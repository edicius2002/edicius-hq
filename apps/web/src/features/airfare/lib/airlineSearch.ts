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
 * On the carriers' own sites there is nothing better waiting: none of the four
 * accepts a flight number in a URL, and three of them do not print flight
 * numbers on the results page at all, because what they sell is a priced option
 * bound to a shopping session that expires.
 *
 * So what a reader gets is the same route on the same date, in the airline's own
 * engine, and they match the departure time by eye. That is a smaller promise
 * than "book LA 191", and every name this module writes is sized to it — see
 * `searchLabel`. The owner chose it over no link at all.
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
 * Deliberately short. Both carriers sell in Brazil, Colombia, Ecuador, Paraguay
 * and Uruguay, and every one of those storefronts has a path slug and a culture
 * string that nobody here has loaded, so guessing them would ship links that
 * 404 in the reader's face — the failure this whole module is arranged to
 * avoid. An origin outside these three gets no LATAM and no JetSMART link, which
 * is the same answer Avianca gets and for the same reason: we do not know the
 * URL.
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
 * Where this route and date can be searched on the airline's own site, or
 * `null` where there is nowhere we know of to send the reader.
 *
 * **Null is a real answer and the caller must render nothing for it**, not a
 * dead link and not a disabled one. Avianca is the standing case: its site is
 * behind Akamai, the investigation that loaded the other three cold could not
 * load it at all, and a URL nobody has opened is a guess. It is 88 offers,
 * about 2% of the archive, and 2% of rows quietly linking to a 404 would cost
 * more trust than 2% of rows linking to nothing costs convenience.
 *
 * The other way to get null is an origin in a country with no storefront in
 * `POINTS_OF_SALE`, which is every country but three.
 */
export function airlineSearchUrl(search: FlightSearch): string | null {
  if (!usable(search)) return null;
  if (search.airline === 'AR') return aerolineas(search);

  const sale = pointOfSale(search.originCountry);
  if (sale === null) return null;
  if (search.airline === 'LA') return latam(search, sale);
  if (search.airline === 'JA') return jetsmart(search, sale);
  return null;
}

/**
 * What the link is called, to a screen reader and to a pointer resting on it.
 *
 * `Search LATAM for LIM to CUZ on 16/10/2026` — a verb the link can keep. It
 * names the carrier, the route and the date, and it deliberately does not name
 * the flight, because the flight is the one thing the destination page will not
 * be filtered to: the reader lands on a list of that day's departures and finds
 * theirs by the clock. `RouteList.module.css` holds this repository's rule
 * against text that reads as a fact and is not one; a link called "Book LA 191"
 * would be exactly that, in the one place where a wrong reading costs money.
 */
export function searchLabel(search: FlightSearch, airlineName: string | null): string {
  const carrier = airlineName ?? search.airline;
  return `Search ${carrier} for ${search.origin} to ${search.destination} on ${formatFlightDate(search.date)}`;
}

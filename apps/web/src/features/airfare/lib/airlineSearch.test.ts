import { describe, expect, it } from 'vitest';

import {
  airlineSearchUrl,
  pointOfSale,
  searchLabel,
  type FlightSearch,
} from '@/features/airfare/lib/airlineSearch';

/**
 * The URLs, and the one thing they are allowed to promise.
 *
 * Every expectation here is a whole URL rather than a parameter fished out of
 * one, because a booking engine's deep link is only ever right or wrong as a
 * whole: `trip=OW` without `/pe/es/` is a 404, and a `culture` without a `cur`
 * is a New Skies session with no currency. Three of these four hosts sit behind
 * bot protection that will not answer a test runner, so a whole-string
 * expectation is also the only alarm that fires when somebody edits one of
 * these builders by hand.
 */

const LIM_CUZ: FlightSearch = {
  airline: 'LA',
  origin: 'LIM',
  destination: 'CUZ',
  date: '2026-09-12',
  originCountry: 'Peru',
};

describe('pointOfSale', () => {
  it('reads a storefront off the origin airport’s country', () => {
    expect(pointOfSale('Peru')).toEqual({
      country: 'pe',
      language: 'es',
      offers: 'ofertas-vuelos',
      currency: 'PEN',
      culture: 'es-PE',
    });
    expect(pointOfSale('Chile')?.currency).toBe('CLP');
    expect(pointOfSale('Argentina')?.country).toBe('ar');
  });

  it('reads the same country however it is spelled or accented', () => {
    /*
     * The country arrives as the provider's own text, not as an ISO code — the
     * code sits one field away in the upstream payload and is not read. So the
     * match has to survive the provider changing its mind about accents, which
     * it can do without changing anything we would notice.
     */
    expect(pointOfSale('Perú')).toEqual(pointOfSale('Peru'));
    expect(pointOfSale('  chile ')).toEqual(pointOfSale('Chile'));
  });

  it('has nothing for a country whose storefront nobody has loaded', () => {
    // Both carriers sell in Brazil. Nobody here has opened the Brazilian path
    // slug, and a guessed slug is a 404 in the reader's face.
    expect(pointOfSale('Brazil')).toBeNull();
    expect(pointOfSale(null)).toBeNull();
    expect(pointOfSale('')).toBeNull();
  });
});

describe('airlineSearchUrl', () => {
  it('sends a LATAM flight to LATAM’s own offers page, in the origin’s storefront', () => {
    expect(airlineSearchUrl(LIM_CUZ)).toBe(
      'https://www.latamairlines.com/pe/es/ofertas-vuelos?origin=LIM&outbound=2026-09-12T00%3A00%3A00.000Z&destination=CUZ&adt=1&chd=0&inf=0&trip=OW&cabin=Economy&redemption=false&sort=RECOMMENDED',
    );
  });

  it('moves the whole LATAM path when the origin is in another country', () => {
    /*
     * The country segment and the language segment are both mandatory, and the
     * slug after them is written in that language. They move together or the
     * link 404s, which is why the point of sale is one value rather than three
     * independent ones.
     */
    const url = airlineSearchUrl({
      ...LIM_CUZ,
      origin: 'SCL',
      destination: 'AEP',
      originCountry: 'Chile',
    });
    expect(url).toContain('https://www.latamairlines.com/cl/es/ofertas-vuelos?');
    expect(url).toContain('origin=SCL');
    expect(url).toContain('destination=AEP');
  });

  it('sends a JetSMART flight to the New Skies engine with a point of sale', () => {
    expect(
      airlineSearchUrl({
        airline: 'JA',
        origin: 'SCL',
        destination: 'ARI',
        date: '2026-09-25',
        originCountry: 'Chile',
      }),
    ).toBe(
      'https://booking.jetsmart.com/Flight/InternalSelect?c=false&mon=false&r=false&cur=CLP&culture=es-CL&dd1=2026-09-25&o1=SCL&d1=ARI&ADT=1&CHD=0&INF=0',
    );
  });

  it('prices JetSMART in the origin country’s currency, not in one currency for all', () => {
    const url = airlineSearchUrl({
      airline: 'JA',
      origin: 'LIM',
      destination: 'AQP',
      date: '2026-09-25',
      originCountry: 'Peru',
    });
    expect(url).toContain('cur=PEN');
    expect(url).toContain('culture=es-PE');
  });

  it('sends an Aerolíneas flight to its one-parameter leg, with no point of sale at all', () => {
    // One host, one country, one currency: a storefront parameter here would be
    // invented to keep the shape of the other two.
    expect(
      airlineSearchUrl({
        airline: 'AR',
        origin: 'AEP',
        destination: 'SCL',
        date: '2026-09-25',
        originCountry: 'Argentina',
      }),
    ).toBe(
      'https://www.aerolineas.com.ar/flights-offers?adt=1&chd=0&inf=0&flexDates=false&cabinClass=Economy&flightType=ONE_WAY&leg=AEP-SCL-20260925',
    );
  });

  it('links an Aerolíneas flight even from an origin with no storefront', () => {
    // It needs no storefront, so not knowing one cannot stop it.
    expect(
      airlineSearchUrl({
        airline: 'AR',
        origin: 'AEP',
        destination: 'GRU',
        date: '2026-09-25',
        originCountry: null,
      }),
    ).toContain('leg=AEP-GRU-20260925');
  });

  it('gives Avianca nothing, because nobody has loaded a URL for it', () => {
    /*
     * 88 offers, about 2% of the archive. The site is behind Akamai and the
     * investigation that opened the other three cold could not open it at all,
     * so any URL here would be a guess — and 2% of rows quietly linking to a
     * 404 costs more than 2% of rows linking to nothing.
     */
    expect(
      airlineSearchUrl({
        airline: 'AV',
        origin: 'LIM',
        destination: 'SCL',
        date: '2026-10-16',
        originCountry: 'Peru',
      }),
    ).toBeNull();
  });

  it('gives a carrier nobody has a URL for nothing, rather than a guess', () => {
    expect(airlineSearchUrl({ ...LIM_CUZ, airline: 'H2' })).toBeNull();
  });

  it('gives nothing where the origin country has no storefront', () => {
    // Not a dead link and not a wrong-currency one: LATAM does sell in Brazil,
    // and the path that reaches its Brazilian offers page is not known here.
    expect(airlineSearchUrl({ ...LIM_CUZ, originCountry: 'Brazil' })).toBeNull();
    expect(airlineSearchUrl({ ...LIM_CUZ, originCountry: null })).toBeNull();
  });

  it('refuses a code or a date that is not one', () => {
    expect(airlineSearchUrl({ ...LIM_CUZ, origin: 'Lima' })).toBeNull();
    expect(airlineSearchUrl({ ...LIM_CUZ, destination: '' })).toBeNull();
    expect(airlineSearchUrl({ ...LIM_CUZ, date: '2026-09' })).toBeNull();
  });
});

describe('searchLabel', () => {
  it('names a search, and does not name the flight', () => {
    /*
     * The whole scope of this feature is in this string. The destination page
     * is a list of that route's departures on that date, filtered to nothing
     * narrower — so a name promising `LA 191` would be a claim the page cannot
     * keep, which is the rule `.report` in `RouteList.module.css` states.
     */
    const label = searchLabel(LIM_CUZ, 'LATAM');
    expect(label).toBe('Search LATAM for LIM to CUZ on 12/09/2026');
    expect(label).not.toContain('191');
    expect(label.toLowerCase()).not.toContain('book');
  });

  it('falls back to the IATA code where the archive has no carrier name', () => {
    expect(searchLabel(LIM_CUZ, null)).toBe('Search LA for LIM to CUZ on 12/09/2026');
  });
});

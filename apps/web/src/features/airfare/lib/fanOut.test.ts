import { describe, expect, it } from 'vitest';

import type { CountryInView } from '@/features/airfare/lib/countries';
import { VIEW_BUDGET_BYTES, planFanOut } from '@/features/airfare/lib/fanOut';

/**
 * What one view is allowed to spend, and what it does when it cannot afford
 * everything in front of it.
 *
 * The sizes here are the real ones, because the policy is only interesting
 * against real ones: Bolivia is 21 kB, Peru 43, Chile 128, Brazil 157, the
 * United States 334 and Canada 508. Two countries can outweigh thirty, which
 * is the whole reason the budget is in bytes.
 */

const BYTES: Record<string, number> = {
  '068': 20_656, // Bolivia
  '604': 43_085, // Peru
  '152': 127_823, // Chile
  '076': 157_078, // Brazil
  '032': 56_692, // Argentina
  '840': 334_166, // United States
  '124': 508_164, // Canada
  '643': 617_988, // Russia
};

const view = (...ids: string[]): CountryInView[] =>
  ids.map((id, at) => ({ id, name: id, cells: 1000 - at }));

describe('planFanOut', () => {
  it('asks for every country in the view, not only the one in the middle', () => {
    const plan = planFanOut(view('604', '068', '152'), '604', BYTES);
    expect(plan.countries).toEqual(['604', '068', '152']);
    expect(plan.refused).toEqual([]);
  });

  it('puts the country under the middle of the frame first, whatever its size', () => {
    /*
     * Near a frontier the neighbour can hold more of the frame than the
     * country you are standing in, and the country you are standing in is
     * still the one you asked for. It was the whole rule before the fan-out
     * and it must not become a country that loses a tie.
     */
    const plan = planFanOut(view('076', '604'), '604', BYTES);
    expect(plan.countries[0]).toBe('604');
    expect(plan.countries).toHaveLength(2);
  });

  it('spends on the countries holding most of the screen', () => {
    const plan = planFanOut(view('604', '152', '068'), '604', BYTES, 70_000);
    expect(plan.countries).toEqual(['604', '068']);
    expect(plan.refused).toEqual(['152']);
  });

  it('never refuses the country the reader is standing in, whatever it weighs', () => {
    /*
     * The map detailed exactly one country before the fan-out and never asked
     * what it cost. A budget that could take Russia's own subdivisions away
     * from a reader standing in Russia would be a step backwards dressed as a
     * policy, so the budget governs the neighbours and the floor underneath it
     * is what the map already did.
     */
    const plan = planFanOut(view('643', '604'), '643', BYTES, 100_000);
    expect(plan.countries).toEqual(['643']);
    expect(plan.bytes).toBeGreaterThan(100_000);
    expect(plan.refused).toEqual(['604']);
  });

  it('passes over a country it cannot afford and keeps spending on smaller ones', () => {
    /*
     * The rule this replaced stopped at the first country that would not fit,
     * so that what was drawn was a prefix of "biggest on screen first".
     * Measured over Europe that was the wrong rule by a long way: Russia is the
     * biggest thing on that screen and 604 kB of a 256 kB budget, and stopping
     * behind it left Germany and Poland coarse for want of the 20 to 50 kB
     * still sitting there.
     */
    const plan = planFanOut(view('604', '124', '068', '152'), '604', BYTES, 200_000);
    expect(plan.countries).toEqual(['604', '068', '152']);
    expect(plan.refused).toEqual(['124']);
  });

  it('says what it refused, because a cap nobody can see is a cap nobody can test', () => {
    const plan = planFanOut(view('604', '840', '124'), '604', BYTES, 60_000);
    expect(plan.countries).toEqual(['604']);
    expect(plan.refused).toEqual(['840', '124']);
    expect(plan.bytes).toBe(43_085);
  });

  it('never asks for a country that has no file, and does not call it refused', () => {
    /*
     * Natural Earth does not divide Western Sahara. Before the index that cost
     * a 404 to find out, which one country per request could afford and a view
     * with thirty of them cannot; and it is not a budget decision, so it is
     * not in `refused`.
     */
    const plan = planFanOut(view('604', '732', '068'), '604', BYTES);
    expect(plan.countries).toEqual(['604', '068']);
    expect(plan.refused).toEqual([]);
  });

  it('falls back to the country under the middle while the index has not landed', () => {
    // Which is exactly how the map behaved before there was an index, so the
    // first view a reader stops on is never blank while waiting to be told
    // what it may draw.
    expect(planFanOut(view('604', '068'), '604', undefined)).toEqual({
      countries: ['604'],
      bytes: 0,
      refused: [],
    });
    expect(planFanOut(view('604'), null, undefined).countries).toEqual([]);
  });

  it('buys the view this change exists for', () => {
    /*
     * The budget is not a round number chosen for looking like one. This is the
     * view the complaint was made about — Peru zoomed into with Bolivia beside
     * it and Chile below the border — and the four countries across that corner
     * are 248 kB together against 256, which is 25 ms of `geoPath` a frame
     * against the 26.3 ms the whole map already costs.
     */
    const tripoint = planFanOut(view('604', '068', '152', '032', '076'), '604', BYTES);
    expect(tripoint.bytes).toBeLessThanOrEqual(VIEW_BUDGET_BYTES);
    expect(tripoint.countries).toEqual(['604', '068', '152', '032']);
    expect(tripoint.bytes).toBe(248_256);
    // Brazil is in the frame at its edge and is the one that will not fit, so
    // it keeps its coarse outline and its own name.
    expect(tripoint.refused).toEqual(['076']);
  });
});

import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { SegmentSummaryItem } from '@/features/greenlight/model/types';
import { SegmentSummary } from '@/features/greenlight/ui/SegmentSummary';

import styles from './SegmentSummary.module.css';

afterEach(cleanup);

/**
 * The first, second and last of the six segments the archive holds today. The
 * second is the sub-minimum one, which is the only place `Fee (under min)` is
 * printed and the longest label a card ever has to fit.
 */
const SEGMENTS: SegmentSummaryItem[] = [
  {
    rangeLabel: '17/04 → 07/05',
    weekCount: 4,
    closed: true,
    amount: 1704.25,
    fee: 170.43,
    net: 1533.82,
    feeCharged: true,
    currency: 'USD',
  },
  {
    rangeLabel: '16/05',
    weekCount: 1,
    closed: true,
    amount: 390,
    fee: 0,
    net: 390,
    feeCharged: false,
    currency: 'USD',
  },
  {
    rangeLabel: '10/08',
    weekCount: 1,
    closed: false,
    amount: 3250.2,
    fee: 325.02,
    net: 2925.18,
    feeCharged: true,
    currency: 'USD',
  },
];

describe('the fee card for one payment segment', () => {
  it('draws one card per segment', () => {
    const { container } = render(<SegmentSummary segments={SEGMENTS} />);

    expect(container.querySelectorAll('article')).toHaveLength(3);
    expect(screen.getAllByText('Gross')).toHaveLength(3);
    expect(screen.getAllByText('Net')).toHaveLength(3);
  });

  it('draws nothing at all when there are no segments', () => {
    const { container } = render(<SegmentSummary segments={[]} />);

    // The page reserves height for the first two on its own; a card grid with
    // no cards in it would reserve that height twice.
    expect(container).toBeEmptyDOMElement();
  });

  it('names the fee for what it is on that segment', () => {
    render(<SegmentSummary segments={SEGMENTS} />);

    // The longest label any card prints, and the one the card width is sized
    // for. It is a label and not a rounding: the fee really is nothing here.
    expect(screen.getByText('Fee (under min)')).toBeTruthy();
    expect(screen.getAllByText('Fee (10%)')).toHaveLength(2);
  });

  it('prints every figure in full, two decimals and all', () => {
    render(<SegmentSummary segments={SEGMENTS} />);

    expect(screen.getByText('$1,704.25')).toBeTruthy();
    expect(screen.getByText('$170.43')).toBeTruthy();
    expect(screen.getByText('$1,533.82')).toBeTruthy();
    expect(screen.getByText('$0.00')).toBeTruthy();
    // Nine characters under this suite's `en-US` and eight under the owner's
    // own locale; `segmentGrid` sizes the card for ten, a place further on.
    expect('$1,704.25').toHaveLength(9);
  });

  it('says how long a closed segment ran and that an open one has not', () => {
    render(<SegmentSummary segments={SEGMENTS} />);

    expect(screen.getByText('4 weeks')).toBeTruthy();
    expect(screen.getByText('1 week')).toBeTruthy();
    expect(screen.getByText('In progress')).toBeTruthy();
  });

  it('marks the open segment apart from the closed ones', () => {
    const { container } = render(<SegmentSummary segments={SEGMENTS} />);
    const cards = [...container.querySelectorAll('article')];

    expect(cards.filter((card) => card.className.includes(styles.open))).toHaveLength(1);
    expect(cards.at(-1)?.className).toContain(styles.open);
  });
});

/**
 * The card is laid out as a grid by `SegmentSummary.module.css` — the range on
 * its own row and the metrics as a ledger under it — and grid placement reads
 * the DOM. Moving a metric out of `.metrics`, or the range out of the header,
 * changes the layout with no stylesheet changing.
 */
describe('the order the card puts its parts in', () => {
  it('is the range and its eyebrow, then the three metrics under them', () => {
    const { container } = render(<SegmentSummary segments={SEGMENTS} />);
    const card = container.querySelector('article');
    const parts = [...(card?.children ?? [])];

    expect(parts).toHaveLength(2);
    expect(parts[0]?.tagName).toBe('HEADER');
    expect(parts[0]?.textContent).toBe('17/04 → 07/054 weeks');
    expect(parts[1]?.className).toContain(styles.metrics);
    expect(parts[1]?.children).toHaveLength(3);
  });

  it('puts the label before the figure in every metric, so one line reads left to right', () => {
    const { container } = render(<SegmentSummary segments={SEGMENTS} />);
    const metrics = [...(container.querySelector('article')?.children ?? [])][1];

    for (const metric of [...(metrics?.children ?? [])]) {
      expect(metric.children[0]?.tagName).toBe('SPAN');
      expect(metric.children[1]?.tagName).toBe('STRONG');
    }

    const first = within(metrics as HTMLElement).getAllByText(/Gross|Fee|Net/);
    expect(first.map((node) => node.textContent)).toEqual(['Gross', 'Fee (10%)', 'Net']);
  });
});

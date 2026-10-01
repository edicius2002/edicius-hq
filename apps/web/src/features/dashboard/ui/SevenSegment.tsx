import styles from './SevenSegment.module.css';

type SevenSegmentProps = {
  digit: string;
};

const litSegmentsByDigit: Record<string, string> = {
  '0': 'abcdef',
  '1': 'bc',
  '2': 'abdeg',
  '3': 'abcdg',
  '4': 'bcfg',
  '5': 'acdfg',
  '6': 'acdefg',
  '7': 'abc',
  '8': 'abcdefg',
  '9': 'abcdfg',
};

const segments = [
  ['a', '3,1 17,1 14,4 6,4'],
  ['b', '18,2 20,4 20,14 17,16 16,13 16,5'],
  ['c', '17,17 20,19 20,29 18,31 16,28 16,20'],
  ['d', '6,28 14,28 17,31 3,31'],
  ['e', '0,19 3,17 4,20 4,28 2,31 0,29'],
  ['f', '2,2 4,5 4,13 3,16 0,14 0,4'],
  ['g', '6,14 14,14 17,16 14,18 6,18 3,16'],
] as const;

export function SevenSegment({ digit }: SevenSegmentProps) {
  const litSegments = litSegmentsByDigit[digit] ?? '';

  return (
    <svg
      className={styles.digit}
      viewBox="0 0 20 32"
      data-digit={digit}
      aria-hidden="true"
      focusable="false"
    >
      {segments.map(([name, points]) => {
        const lit = litSegments.includes(name);
        return (
          <polygon
            key={name}
            points={points}
            className={lit ? styles.lit : styles.unlit}
            data-segment={name}
            data-lit={lit}
          />
        );
      })}
    </svg>
  );
}

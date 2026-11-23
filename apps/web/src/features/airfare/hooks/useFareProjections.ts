import { useQueries, useQuery } from '@tanstack/react-query';
import type { FareRoute } from '@/features/airfare/data/fareRoutes';
import type { FareMonthProjection } from '@/features/airfare/data/fareProjections';
import { fareProjectionOptions } from '@/features/airfare/data/fareQueryOptions';
import { useRetainedData } from '@/shared/lib/useRetainedData';

export function useFareProjections(route: FareRoute | null, month: string | null) {
  const primary = useQuery({
    ...fareProjectionOptions(route?.origin ?? '', route?.destination ?? '', month ?? ''),
    enabled: route !== null && month !== null,
  });

  const data = useRetainedData(`${route?.origin}|${route?.destination}`, primary.data);

  // The selected month paints first; other watched months only supply departure
  // frames when they arrive and each remains cached under its own month key.
  const secondaryMonths =
    route?.months.filter((other) => other !== month && other !== data?.month) ?? [];
  const secondary = useQueries({
    queries: secondaryMonths.map((other) => ({
      ...fareProjectionOptions(route!.origin, route!.destination, other),
      enabled: primary.data !== undefined,
    })),
    combine: (results) => ({
      boards: results.flatMap((result) => result.data?.currentBoards ?? []),
      checks: results.flatMap((result) => result.data?.departureChecks ?? []),
      fetched: results.flatMap((result) =>
        result.data && hasCollectedHistory(result.data) ? [result.data.month] : [],
      ),
      unavailable: results.flatMap((result, index) =>
        result.data === undefined ? [secondaryMonths[index]] : [],
      ),
    }),
  });

  const fetched = new Set([
    ...(data && hasCollectedHistory(data) ? [data.month] : []),
    ...secondary.fetched,
  ]);

  return {
    primary: {
      ...primary,
      data,
      isPending: primary.isPending && data === undefined,
      isPreviousData: primary.data === undefined && data !== undefined,
    },
    secondaryBoards: secondary.boards,
    secondaryChecks: secondary.checks,
    fetchedMonths: route?.months.filter((watched) => fetched.has(watched)) ?? [],
    unavailableMonths: [
      ...(primary.data === undefined && month ? [month] : []),
      ...secondary.unavailable,
    ],
  };
}

function hasCollectedHistory(projection: FareMonthProjection): boolean {
  return (
    projection.latestCapture !== null ||
    projection.priceDays.length > 0 ||
    projection.providerDays.length > 0 ||
    projection.unsoldDays.length > 0 ||
    projection.departureChecks.length > 0
  );
}

import type { PageSkeletonKind } from './PageSkeleton';

export function pageSkeletonForPath(pathname: string): PageSkeletonKind {
  const segment = pathname.split('/')[1];
  if (segment === 'seace') return 'seace';
  if (
    segment === 'dashboard' ||
    segment === 'finance' ||
    segment === 'greenlight' ||
    segment === 'investing' ||
    segment === 'airfare' ||
    segment === 'sentiment'
  )
    return segment;
  return 'error';
}

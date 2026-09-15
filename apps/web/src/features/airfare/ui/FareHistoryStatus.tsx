import { Button } from '@/shared/ui/Button';

export function FareHistoryStatus({
  loading = false,
  error,
  onRetry,
}: {
  loading?: boolean;
  error?: Error | null;
  onRetry?: () => void;
}) {
  if (loading) return <p role="status">Loading saved fares…</p>;
  if (!error) return null;
  return (
    <div role="alert">
      <p>Could not load saved fares. Previously loaded data is kept when available.</p>
      {onRetry ? (
        <Button size="small" onClick={onRetry}>
          Retry loading fares
        </Button>
      ) : null}
    </div>
  );
}

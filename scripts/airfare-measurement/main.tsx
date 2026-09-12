import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryProvider } from '@/app/providers/QueryProvider';
import { AirfarePage } from '@/features/airfare/AirfarePage';
import '@/styles/index.css';

declare global {
  interface Window {
    airfareMeasurement: {
      parsing: { pair: string; kind: string; count: number; duration: number; end: number }[];
      longTasks: { startTime: number; duration: number }[];
      bodyReads: { url: string; duration: number; end: number }[];
    };
  }
}

// Isolated measurement entry: actual page, no production session or writes.
window.airfareMeasurement = { parsing: [], longTasks: [], bodyReads: [] };
const parseOriginal = JSON.parse;
JSON.parse = (text, reviver) => {
  const start = performance.now();
  const data = parseOriginal(text, reviver);
  if (data?.origin && (data.snapshots || 'horizon' in data)) {
    window.airfareMeasurement.parsing.push({
      pair: `${data.origin}-${data.destination}`,
      kind: data.snapshots ? 'history' : 'calendar',
      count: data.snapshots?.length ?? data.horizon?.prices.length ?? 0,
      duration: performance.now() - start,
      end: performance.now(),
    });
  }
  return data;
};
new PerformanceObserver((list) => {
  window.airfareMeasurement.longTasks.push(
    ...list.getEntries().map(({ startTime, duration }) => ({ startTime, duration })),
  );
}).observe({ type: 'longtask', buffered: true });
const fetchOriginal = window.fetch.bind(window);
window.fetch = async (...args) => {
  const response = await fetchOriginal(...args);
  const textOriginal = response.text.bind(response);
  response.text = async () => {
    const start = performance.now();
    const data = await textOriginal();
    window.airfareMeasurement.bodyReads.push({
      url: String(args[0]),
      duration: performance.now() - start,
      end: performance.now(),
    });
    return data;
  };
  return response;
};
createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <QueryProvider>
      <AirfarePage />
    </QueryProvider>
  </BrowserRouter>,
);

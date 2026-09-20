// Request-local timings: never include questions, answers, identifiers or credentials.
export function createTimings(now = () => performance.now()) {
  const start = now();
  const durations = new Map();
  const snapshot = () => Object.fromEntries([...durations, ['total', now() - start]]
    .map(([name, duration]) => [name, Math.max(0, Number(duration.toFixed(1)))]));
  return {
    async measure(name, operation) {
      const before = now();
      try { return await operation(); }
      finally { durations.set(name, (durations.get(name) || 0) + now() - before); }
    },
    header() {
      return Object.entries(snapshot())
        .map(([name, duration]) => `${name};dur=${Number(duration).toFixed(1)}`).join(', ');
    },
    snapshot,
  };
}

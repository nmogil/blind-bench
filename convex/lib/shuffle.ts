/**
 * Cryptographically random Fisher-Yates shuffle.
 * Uses crypto.getRandomValues.
 * Must run server-side so the client never sees the original ordering.
 */
export function fisherYatesShuffle<T>(array: T[]): T[] {
  const shuffled = [...array];
  if (shuffled.length <= 1) return shuffled;

  const randomValues = new Uint32Array(shuffled.length);
  crypto.getRandomValues(randomValues);

  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = randomValues[i]! % (i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }

  return shuffled;
}

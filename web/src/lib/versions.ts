// App versions the way this project numbers builds: x.y.z (0.0.9, then 0.1.0, then 0.1.2). Anything else, like "2.3",
// can still be picked in a filter but is flagged, and the server never treats it as the latest build.
export const isReleaseVersion = (value: string): boolean => /^\d+\.\d+\.\d+$/.test(value);

/** Numeric, part by part: 0.0.9 < 0.0.10 < 0.1.0. Text without digits sorts last. */
export function compareVersions(a: string, b: string): number {
  const parts = (value: string) => value.match(/\d+/g)?.map(Number) ?? [];
  const left = parts(a); const right = parts(b);
  if (!left.length || !right.length) return left.length ? -1 : right.length ? 1 : a.localeCompare(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference) return difference;
  }
  return a.localeCompare(b);
}

/** The versions in the order of the filter list: numbered releases oldest to newest, then the odd ones. */
export const sortVersions = (values: string[]): string[] => [...values].sort((a, b) => Number(isReleaseVersion(b)) - Number(isReleaseVersion(a)) || compareVersions(a, b));

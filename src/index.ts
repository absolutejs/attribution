export const GOOGLE_CLICK_ID_PARAMETERS = [
  "gclid",
  "gbraid",
  "wbraid",
] as const;

export type GoogleClickIdParameter =
  (typeof GOOGLE_CLICK_ID_PARAMETERS)[number];
export type GoogleClickIdentifiers = Partial<
  Record<GoogleClickIdParameter, string>
>;

export type AttributionSnapshot = {
  capturedAt: number;
  identifiers: GoogleClickIdentifiers;
};

export type AttributionStorage = Pick<
  Storage,
  "getItem" | "removeItem" | "setItem"
>;

export type AttributionStore = {
  capture: (source?: string | URL) => AttributionSnapshot | null;
  clear: () => void;
  decorate: (target: string | URL, allowedOrigins: readonly string[]) => string;
  hasClickId: () => boolean;
  read: () => AttributionSnapshot | null;
};

export type AttributionStoreOptions = {
  key?: string;
  maxAgeMs?: number;
  now?: () => number;
  storage?: AttributionStorage;
};

const DEFAULT_KEY = "absolute_attribution";
const DEFAULT_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1_000;
const MAX_CLICK_ID_LENGTH = 512;
const CLICK_ID = /^[A-Za-z0-9._~-]+$/;

const validClickId = (value: string | null): value is string =>
  value !== null &&
  value.length > 0 &&
  value.length <= MAX_CLICK_ID_LENGTH &&
  CLICK_ID.test(value);

export const readGoogleClickIdentifiers = (
  source: string | URL,
): GoogleClickIdentifiers => {
  const url = source instanceof URL ? source : new URL(source);
  const identifiers: GoogleClickIdentifiers = {};
  for (const parameter of GOOGLE_CLICK_ID_PARAMETERS) {
    const value = url.searchParams.get(parameter);
    if (validClickId(value)) identifiers[parameter] = value;
  }

  return identifiers;
};

export const hasGoogleClickIdentifiers = (
  identifiers: GoogleClickIdentifiers | null | undefined,
) =>
  identifiers !== null &&
  identifiers !== undefined &&
  GOOGLE_CLICK_ID_PARAMETERS.some((parameter) =>
    validClickId(identifiers[parameter] ?? null),
  );

export const decorateAttributionUrl = (
  target: string | URL,
  identifiers: GoogleClickIdentifiers,
  allowedOrigins: readonly string[],
) => {
  const url = target instanceof URL ? new URL(target) : new URL(target);
  if (!allowedOrigins.includes(url.origin)) return url.toString();
  for (const parameter of GOOGLE_CLICK_ID_PARAMETERS) {
    const value = identifiers[parameter];
    if (validClickId(value ?? null)) url.searchParams.set(parameter, value!);
  }

  return url.toString();
};

const browserStorage = () =>
  typeof window === "undefined" ? undefined : window.sessionStorage;

export const createAttributionStore = (
  options: AttributionStoreOptions = {},
): AttributionStore => {
  const key = options.key ?? DEFAULT_KEY;
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const now = options.now ?? Date.now;
  const storage = options.storage ?? browserStorage();

  const clear = () => storage?.removeItem(key);
  const read = (): AttributionSnapshot | null => {
    const serialized = storage?.getItem(key);
    if (!serialized) return null;
    try {
      const parsed = JSON.parse(serialized) as Partial<AttributionSnapshot>;
      if (
        typeof parsed.capturedAt !== "number" ||
        !Number.isFinite(parsed.capturedAt) ||
        now() - parsed.capturedAt > maxAgeMs ||
        now() < parsed.capturedAt ||
        !hasGoogleClickIdentifiers(parsed.identifiers)
      ) {
        clear();

        return null;
      }

      return {
        capturedAt: parsed.capturedAt,
        identifiers: readGoogleClickIdentifiers(
          `https://attribution.invalid/?${new URLSearchParams(parsed.identifiers)}`,
        ),
      };
    } catch {
      clear();

      return null;
    }
  };

  return {
    capture: (
      source = typeof location === "undefined" ? undefined : location.href,
    ) => {
      if (source === undefined || storage === undefined) return read();
      const identifiers = readGoogleClickIdentifiers(source);
      if (!hasGoogleClickIdentifiers(identifiers)) return read();
      const snapshot = { capturedAt: now(), identifiers };
      storage.setItem(key, JSON.stringify(snapshot));

      return snapshot;
    },
    clear,
    decorate: (target, allowedOrigins) =>
      decorateAttributionUrl(target, read()?.identifiers ?? {}, allowedOrigins),
    hasClickId: () => hasGoogleClickIdentifiers(read()?.identifiers),
    read,
  };
};

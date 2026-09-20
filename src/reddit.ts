/** Reddit's browser pixel, loaded only after explicit marketing consent. */
export type RedditEvent =
  | "PageVisit"
  | "ViewContent"
  | "Search"
  | "AddToCart"
  | "AddToWishlist"
  | "Purchase"
  | "Lead"
  | "SignUp"
  | "Custom";

export type RedditEventMetadata = {
  conversionId?: string;
  currency?: string;
  /** Major currency units, e.g. 12.50 USD (not cents). */
  value?: number;
  itemCount?: number;
  customEventName?: string;
  products?: { id?: string; name?: string; category?: string }[];
};

export type RedditPixelState =
  "idle" | "loading" | "ready" | "failed" | "closed";
export type RedditPixelOptions = {
  id: string;
  consent: boolean;
  window?: Window;
  document?: Document;
  loadTimeoutMs?: number;
};
export type RedditPixelController = {
  start: () => void;
  state: () => RedditPixelState;
  /** True means handed to the SDK, not confirmed delivery to Reddit. */
  track: (
    event: RedditEvent,
    metadata?: RedditEventMetadata,
  ) => Promise<boolean>;
  updateConsent: (granted: boolean) => void;
  close: () => void;
};

type RedditTag = ((...args: unknown[]) => void) & {
  callQueue: unknown[][];
  sendEvent?: (...args: unknown[]) => void;
};
type RedditWindow = Window & { rdt?: RedditTag };
type PendingEvent = {
  event: RedditEvent;
  metadata: RedditEventMetadata;
  resolve: (sent: boolean) => void;
};

const PIXEL_SRC = "https://www.redditstatic.com/ads/pixel.js";
const controllers = new WeakMap<
  Window,
  { id: string; controller: RedditPixelController }
>();

export const createRedditPixel = (
  options: RedditPixelOptions,
): RedditPixelController => {
  const browser =
    options.window ?? (typeof window === "undefined" ? undefined : window);
  const document = options.document ?? browser?.document;
  const existing = browser && controllers.get(browser);
  if (existing) {
    if (existing.id !== options.id)
      throw new Error("A different Reddit pixel already owns this window");
    return existing.controller;
  }
  const target = browser as RedditWindow | undefined;
  let state: RedditPixelState = "idle";
  let consent = options.consent;
  let script: HTMLScriptElement | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let initialized = false;
  let pageVisited = false;
  let pending: PendingEvent[] = [];
  const sent = new Set<string>();
  const timeoutMs = options.loadTimeoutMs ?? 2_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new Error("Invalid Reddit pixel load timeout");

  const discard = () => {
    for (const event of pending) event.resolve(false);
    pending = [];
  };
  const send = (event: RedditEvent, metadata: RedditEventMetadata): boolean => {
    if (!consent || state !== "ready" || !target?.rdt?.sendEvent) return false;
    const key = metadata.conversionId
      ? `${event}:${metadata.conversionId}`
      : undefined;
    if (key && sent.has(key)) return false;
    try {
      // The SDK mutates metadata; never give it application-owned objects.
      target.rdt("track", event, structuredClone(metadata));
      if (key) sent.add(key);
      return true;
    } catch {
      return false;
    }
  };
  const activate = () => {
    if (!consent || state !== "ready" || !target?.rdt) return;
    try {
      if (!initialized) {
        target.rdt("init", options.id, { useDecimalCurrencyValues: true });
        initialized = true;
      }
      if (!pageVisited) pageVisited = send("PageVisit", {});
      const events = pending;
      pending = [];
      for (const event of events)
        event.resolve(send(event.event, event.metadata));
    } catch {
      state = "failed";
      discard();
    }
  };
  const cleanupLoad = () => {
    clearTimeout(timeout);
    script?.removeEventListener("load", onLoad);
    script?.removeEventListener("error", onError);
  };
  const onError = () => {
    cleanupLoad();
    state = "failed";
    script?.remove();
    discard();
  };
  const onLoad = () => {
    cleanupLoad();
    if (!target?.rdt?.sendEvent) {
      onError();
      return;
    }
    state = "ready";
    activate();
  };
  const start = () => {
    if (!target || !document || !options.id || !consent || state !== "idle")
      return;
    // Never reinitialize somebody else's pixel or change its account/settings.
    if (target.rdt) {
      state = "failed";
      discard();
      return;
    }
    const tag: RedditTag = Object.assign(
      (...args: unknown[]) => {
        if (tag.sendEvent) tag.sendEvent(...args);
        else tag.callQueue.push(args);
      },
      { callQueue: [] as unknown[][] },
    );
    target.rdt = tag;
    state = "loading";
    script = document.createElement("script");
    script.async = true;
    // Initialize on load rather than queuing init: withdrawal during download
    // must not initialize tracking or replay pending conversions afterward.
    script.src = PIXEL_SRC;
    script.addEventListener("load", onLoad);
    script.addEventListener("error", onError);
    timeout = setTimeout(onError, timeoutMs);
    try {
      document.head.appendChild(script);
    } catch {
      onError();
    }
  };
  const controller: RedditPixelController = {
    start,
    state: () => state,
    track: (event, metadata = {}) => {
      if (
        !consent ||
        !target ||
        !document ||
        !options.id ||
        state === "closed" ||
        state === "failed"
      )
        return Promise.resolve(false);
      if (
        metadata.value !== undefined &&
        (!Number.isFinite(metadata.value) || metadata.value < 0)
      )
        return Promise.resolve(false);
      if (event === "Custom" && !metadata.customEventName)
        return Promise.resolve(false);
      start();
      if (state === "ready") return Promise.resolve(send(event, metadata));
      if (state !== "loading" || pending.length >= 100)
        return Promise.resolve(false);
      return new Promise((resolve) =>
        pending.push({ event, metadata: structuredClone(metadata), resolve }),
      );
    },
    updateConsent: (granted) => {
      if (state === "closed") return;
      consent = granted;
      if (!granted) {
        discard();
        if (initialized) {
          // There is no SDK unload command. Hosts must reload after withdrawal
          // to stop any automatic listeners configured in Reddit's dashboard.
          try {
            target?.rdt?.("disableFirstPartyCookies");
          } catch {
            /* fail closed */
          }
        }
        return;
      }
      if (initialized) {
        try {
          target?.rdt?.("enableFirstPartyCookies");
        } catch {
          /* no-op */
        }
      }
      start();
      activate();
    },
    close: () => {
      consent = false;
      state = "closed";
      cleanupLoad();
      script?.remove();
      discard();
    },
  };
  if (browser && options.id)
    controllers.set(browser, { id: options.id, controller });
  return controller;
};

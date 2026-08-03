import type { AttributionStore, GoogleClickIdentifiers } from "./index";

export type GoogleConsentStatus = "denied" | "granted";
export type GoogleAdsConsent = {
  adPersonalization: GoogleConsentStatus;
  adStorage: GoogleConsentStatus;
  adUserData: GoogleConsentStatus;
  analyticsStorage: GoogleConsentStatus;
};

export type GoogleTagState =
  | "closed"
  | "failed"
  | "idle"
  | "loading"
  | "ready"
  | "waiting-online"
  | "waiting-visible";

export type GoogleTagFailureReason =
  "csp-blocked" | "load-timeout" | "network-or-client-blocked" | "offline";

export type GoogleTagResourceTiming = {
  durationMs: number;
  entryFound: boolean;
  responseStatus: number;
  transferSize: number;
};

export type GoogleTagTelemetry = {
  attempt: number;
  attemptElapsedMs: number;
  consent: GoogleAdsConsent;
  elapsedMs: number;
  event:
    | "closed"
    | "failed"
    | "load-attempt"
    | "ready"
    | "retry-scheduled"
    | "waiting-online"
    | "waiting-visible";
  failureReason?: GoogleTagFailureReason;
  hadGoogleClickId: boolean;
  hadExistingTag: boolean;
  online: boolean;
  recovered: boolean;
  resourceTiming?: GoogleTagResourceTiming;
  visibilityState: DocumentVisibilityState | "unknown";
};

export type GoogleTag = (...args: unknown[]) => void;

declare global {
  interface Window {
    dataLayer?: IArguments[];
    gtag?: GoogleTag;
  }
}

export type GoogleAdsTagOptions = {
  attribution?: AttributionStore;
  consent: GoogleAdsConsent;
  document?: Document;
  id: string;
  loadTimeoutMs?: number;
  maxAttempts?: number;
  onTelemetry?: (event: GoogleTagTelemetry) => void;
  performance?: Performance;
  retryDelaysMs?: readonly number[];
  window?: Window;
};

export type GoogleConversion = {
  currency?: string;
  onComplete?: () => void;
  sendTo: string;
  timeoutMs?: number;
  transactionId?: string;
  value?: number;
};

export type GoogleAdsTagController = {
  close: () => void;
  retry: () => void;
  start: () => void;
  state: () => GoogleTagState;
  trackConversion: (conversion: GoogleConversion) => void;
  updateConsent: (consent: GoogleAdsConsent) => void;
};

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_LOAD_TIMEOUT_MS = 12_000;
const DEFAULT_RETRY_DELAYS_MS = [2_000, 15_000] as const;
const DEFAULT_CONVERSION_TIMEOUT_MS = 2_000;
const GTAG_SRC = "https://www.googletagmanager.com/gtag/js";

const consentPayload = (consent: GoogleAdsConsent) => ({
  ad_personalization: consent.adPersonalization,
  ad_storage: consent.adStorage,
  ad_user_data: consent.adUserData,
  analytics_storage: consent.analyticsStorage,
});

export const createGoogleAdsTag = (
  options: GoogleAdsTagOptions,
): GoogleAdsTagController => {
  const browserWindow =
    options.window ?? (typeof window === "undefined" ? undefined : window);
  const browserDocument =
    options.document ??
    (typeof document === "undefined" ? undefined : document);
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const loadTimeoutMs = Math.max(
    1,
    options.loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS,
  );
  const retryDelays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const browserPerformance =
    options.performance ??
    (typeof performance === "undefined" ? undefined : performance);
  let attempt = 0;
  let attemptStartedAt = 0;
  let bootstrapped = false;
  let closed = false;
  let cspBlocked = false;
  let currentConsent = options.consent;
  const hadExistingTag = browserWindow?.gtag !== undefined;
  let loadTimer: ReturnType<typeof setTimeout> | undefined;
  let loadSettled = false;
  let onlineListener: (() => void) | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let script: HTMLScriptElement | undefined;
  const startedAt = Date.now();
  let tagState: GoogleTagState = "idle";
  let visibilityListener: (() => void) | undefined;

  const hadGoogleClickId = () => options.attribution?.hasClickId() ?? false;
  const visibilityState = () => browserDocument?.visibilityState ?? "unknown";
  const online = () => browserWindow?.navigator.onLine !== false;
  const resourceTiming = (): GoogleTagResourceTiming | undefined => {
    if (browserPerformance === undefined || script === undefined)
      return undefined;
    const entries = browserPerformance.getEntriesByName(script.src, "resource");
    const entry = entries.at(-1) as PerformanceResourceTiming | undefined;
    if (entry === undefined) {
      return {
        durationMs: 0,
        entryFound: false,
        responseStatus: 0,
        transferSize: 0,
      };
    }

    return {
      durationMs: Math.round(entry.duration),
      entryFound: true,
      responseStatus:
        "responseStatus" in entry ? Number(entry.responseStatus) : 0,
      transferSize: entry.transferSize,
    };
  };
  const telemetry = (
    event: GoogleTagTelemetry["event"],
    failureReason?: GoogleTagFailureReason,
  ) => {
    const timing =
      event === "failed" || event === "ready" || event === "retry-scheduled"
        ? resourceTiming()
        : undefined;
    options.onTelemetry?.({
      attempt,
      attemptElapsedMs:
        attemptStartedAt === 0 ? 0 : Math.max(0, Date.now() - attemptStartedAt),
      consent: { ...currentConsent },
      elapsedMs: Math.max(0, Date.now() - startedAt),
      event,
      ...(failureReason === undefined ? {} : { failureReason }),
      hadGoogleClickId: hadGoogleClickId(),
      hadExistingTag,
      online: online(),
      recovered: event === "ready" && attempt > 1,
      ...(timing === undefined ? {} : { resourceTiming: timing }),
      visibilityState: visibilityState(),
    });
  };

  const ensureQueue = () => {
    if (browserWindow === undefined) return undefined;
    const dataLayer = browserWindow.dataLayer ?? [];
    browserWindow.dataLayer = dataLayer;
    browserWindow.gtag ??= function () {
      dataLayer.push(arguments);
    };

    return browserWindow.gtag;
  };

  const bootstrap = () => {
    const gtag = ensureQueue();
    if (gtag === undefined || bootstrapped) return gtag;
    bootstrapped = true;
    gtag("consent", "default", consentPayload(currentConsent));
    gtag("set", "ads_data_redaction", currentConsent.adUserData === "denied");
    gtag("set", "url_passthrough", true);
    gtag("js", new Date());
    gtag("config", options.id);

    return gtag;
  };

  const removeOnlineListener = () => {
    if (onlineListener === undefined || browserWindow === undefined) return;
    browserWindow.removeEventListener("online", onlineListener);
    onlineListener = undefined;
  };

  const removeVisibilityListener = () => {
    if (visibilityListener === undefined || browserDocument === undefined)
      return;
    browserDocument.removeEventListener("visibilitychange", visibilityListener);
    visibilityListener = undefined;
  };

  const clearLoadTimer = () => {
    if (loadTimer === undefined) return;
    clearTimeout(loadTimer);
    loadTimer = undefined;
  };

  const waitUntilAvailable = (resume: () => void) => {
    if (!online()) {
      tagState = "waiting-online";
      telemetry("waiting-online", "offline");
      if (onlineListener === undefined && browserWindow !== undefined) {
        onlineListener = () => {
          removeOnlineListener();
          if (!waitUntilAvailable(resume)) resume();
        };
        browserWindow.addEventListener("online", onlineListener, {
          once: true,
        });
      }

      return true;
    }
    if (visibilityState() === "hidden") {
      tagState = "waiting-visible";
      telemetry("waiting-visible");
      if (visibilityListener === undefined && browserDocument !== undefined) {
        visibilityListener = () => {
          if (visibilityState() === "hidden") return;
          removeVisibilityListener();
          if (!waitUntilAvailable(resume)) resume();
        };
        browserDocument.addEventListener(
          "visibilitychange",
          visibilityListener,
        );
      }

      return true;
    }

    return false;
  };

  const failureReason = (timedOut: boolean): GoogleTagFailureReason => {
    if (!online()) return "offline";
    if (cspBlocked) return "csp-blocked";
    if (timedOut) return "load-timeout";

    return "network-or-client-blocked";
  };

  const scheduleRetry = (
    resume: () => void,
    reason: GoogleTagFailureReason,
  ) => {
    tagState = "idle";
    telemetry("retry-scheduled", reason);
    const delay =
      retryDelays[Math.min(attempt - 1, retryDelays.length - 1)] ?? 0;
    retryTimer = setTimeout(() => {
      if (!waitUntilAvailable(resume)) resume();
    }, delay);
  };

  const attemptLoad = () => {
    if (
      closed ||
      browserWindow === undefined ||
      browserDocument === undefined ||
      !options.id
    )
      return;
    bootstrap();
    if (waitUntilAvailable(attemptLoad)) return;

    attempt += 1;
    attemptStartedAt = Date.now();
    cspBlocked = false;
    loadSettled = false;
    tagState = "loading";
    telemetry("load-attempt");
    script = browserDocument.createElement("script");
    script.async = true;
    script.dataset.absoluteAttribution = "google-ads";
    script.src = `${GTAG_SRC}?id=${encodeURIComponent(options.id)}`;
    script.addEventListener(
      "load",
      () => {
        if (closed || loadSettled) return;
        loadSettled = true;
        clearLoadTimer();
        tagState = "ready";
        telemetry("ready");
      },
      { once: true },
    );
    script.addEventListener("error", () => handleLoadFailure(false), {
      once: true,
    });
    loadTimer = setTimeout(() => handleLoadFailure(true), loadTimeoutMs);
    browserDocument.head.appendChild(script);
  };

  const handleLoadFailure = (timedOut: boolean) => {
    if (closed || loadSettled) return;
    loadSettled = true;
    clearLoadTimer();
    const reason = failureReason(timedOut);
    script?.remove();
    if (reason === "offline") {
      attempt = Math.max(0, attempt - 1);
      script = undefined;
      waitUntilAvailable(attemptLoad);

      return;
    }
    if (reason === "csp-blocked" || attempt >= maxAttempts) {
      tagState = "failed";
      telemetry("failed", reason);
      script = undefined;

      return;
    }
    scheduleRetry(attemptLoad, reason);
    script = undefined;
  };

  const onCspViolation = (event: Event) => {
    const violation = event as SecurityPolicyViolationEvent;
    if (
      violation.blockedURI.startsWith("https://www.googletagmanager.com/") &&
      violation.effectiveDirective.startsWith("script-src")
    )
      cspBlocked = true;
  };
  browserDocument?.addEventListener("securitypolicyviolation", onCspViolation);

  return {
    close: () => {
      if (closed) return;
      closed = true;
      tagState = "closed";
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      clearLoadTimer();
      removeOnlineListener();
      removeVisibilityListener();
      browserDocument?.removeEventListener(
        "securitypolicyviolation",
        onCspViolation,
      );
      script?.remove();
      telemetry("closed");
    },
    retry: () => {
      if (closed || tagState !== "failed") return;
      attempt = 0;
      tagState = "idle";
      attemptLoad();
    },
    start: () => {
      if (closed || tagState !== "idle") return;
      attemptLoad();
    },
    state: () => tagState,
    trackConversion: (conversion) => {
      const gtag = bootstrap();
      if (gtag === undefined) {
        conversion.onComplete?.();

        return;
      }
      let completed = false;
      const finish = () => {
        if (completed) return;
        completed = true;
        clearTimeout(timeout);
        conversion.onComplete?.();
      };
      const timeoutMs = conversion.timeoutMs ?? DEFAULT_CONVERSION_TIMEOUT_MS;
      const timeout = setTimeout(finish, timeoutMs);
      gtag("event", "conversion", {
        event_callback: finish,
        event_timeout: timeoutMs,
        send_to: conversion.sendTo,
        ...(conversion.currency === undefined
          ? {}
          : { currency: conversion.currency }),
        ...(conversion.transactionId === undefined
          ? {}
          : { transaction_id: conversion.transactionId }),
        ...(conversion.value === undefined ? {} : { value: conversion.value }),
      });
    },
    updateConsent: (consent) => {
      currentConsent = consent;
      const gtag = bootstrap();
      gtag?.("consent", "update", consentPayload(consent));
      gtag?.("set", "ads_data_redaction", consent.adUserData === "denied");
    },
  };
};

export type GoogleDataManagerConsent = {
  adPersonalization: GoogleConsentStatus;
  adUserData: GoogleConsentStatus;
};

export type GoogleDataManagerConversion = {
  consent: GoogleDataManagerConsent;
  conversionValue?: number;
  currency?: string;
  eventTimestamp: string;
  identifiers: GoogleClickIdentifiers;
  transactionId: string;
};

export type GoogleDataManagerOptions = {
  accessToken: () => Promise<string>;
  accountId: string;
  conversionActionId: string;
  endpoint?: string;
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  loginAccountId?: string;
  validateOnly?: boolean;
};

export type GoogleDataManagerResult = {
  fieldWarnings?: unknown[];
  requestId: string;
};

const consentStatus = (status: GoogleConsentStatus) =>
  status === "granted" ? "GRANTED" : "DENIED";

export const sendGoogleAdsDataManagerConversion = async (
  options: GoogleDataManagerOptions,
  conversion: GoogleDataManagerConversion,
): Promise<GoogleDataManagerResult> => {
  if (!conversion.transactionId.trim())
    throw new Error("Google conversion transactionId is required");
  if (!Number.isFinite(Date.parse(conversion.eventTimestamp)))
    throw new Error("Google conversion eventTimestamp must be RFC 3339");
  if (
    conversion.identifiers.gclid === undefined &&
    conversion.identifiers.gbraid === undefined &&
    conversion.identifiers.wbraid === undefined
  )
    throw new Error("Google conversion requires a click identifier");

  const request = {
    consent: {
      adPersonalization: consentStatus(conversion.consent.adPersonalization),
      adUserData: consentStatus(conversion.consent.adUserData),
    },
    destinations: [
      {
        operatingAccount: {
          accountId: options.accountId,
          accountType: "GOOGLE_ADS",
        },
        ...(options.loginAccountId === undefined
          ? {}
          : {
              loginAccount: {
                accountId: options.loginAccountId,
                accountType: "GOOGLE_ADS",
              },
            }),
        productDestinationId: options.conversionActionId,
      },
    ],
    events: [
      {
        adIdentifiers: conversion.identifiers,
        eventSource: "WEB",
        eventTimestamp: conversion.eventTimestamp,
        transactionId: conversion.transactionId,
        ...(conversion.conversionValue === undefined
          ? {}
          : { conversionValue: conversion.conversionValue }),
        ...(conversion.currency === undefined
          ? {}
          : { currency: conversion.currency }),
      },
    ],
    validateOnly: options.validateOnly ?? false,
  };
  const response = await (options.fetch ?? fetch)(
    options.endpoint ?? "https://datamanager.googleapis.com/v1/events:ingest",
    {
      body: JSON.stringify(request),
      headers: {
        authorization: `Bearer ${await options.accessToken()}`,
        "content-type": "application/json",
      },
      method: "POST",
    },
  );
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 2_000);
    throw new Error(`Google Data Manager request failed (${response.status})`, {
      cause: detail,
    });
  }

  return (await response.json()) as GoogleDataManagerResult;
};

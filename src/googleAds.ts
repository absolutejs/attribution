import type { AttributionStore, GoogleClickIdentifiers } from "./index";

export type GoogleConsentStatus = "denied" | "granted";
export type GoogleAdsConsent = {
  adPersonalization: GoogleConsentStatus;
  adStorage: GoogleConsentStatus;
  adUserData: GoogleConsentStatus;
  analyticsStorage: GoogleConsentStatus;
};

export type GoogleTagState =
  "closed" | "failed" | "idle" | "loading" | "ready" | "waiting-online";

export type GoogleTagTelemetry = {
  attempt: number;
  event:
    | "closed"
    | "failed"
    | "load-attempt"
    | "ready"
    | "retry-scheduled"
    | "waiting-online";
  hadGoogleClickId: boolean;
  recovered: boolean;
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
  maxAttempts?: number;
  onTelemetry?: (event: GoogleTagTelemetry) => void;
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
const DEFAULT_RETRY_DELAYS_MS = [1_000, 4_000] as const;
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
  const retryDelays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  let attempt = 0;
  let bootstrapped = false;
  let closed = false;
  let currentConsent = options.consent;
  let onlineListener: (() => void) | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let script: HTMLScriptElement | undefined;
  let tagState: GoogleTagState = "idle";

  const hadGoogleClickId = () => options.attribution?.hasClickId() ?? false;
  const telemetry = (event: GoogleTagTelemetry["event"]) =>
    options.onTelemetry?.({
      attempt,
      event,
      hadGoogleClickId: hadGoogleClickId(),
      recovered: event === "ready" && attempt > 1,
    });

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

  const attemptLoad = () => {
    if (
      closed ||
      browserWindow === undefined ||
      browserDocument === undefined ||
      !options.id
    )
      return;
    bootstrap();
    if (browserWindow.navigator.onLine === false) {
      tagState = "waiting-online";
      telemetry("waiting-online");
      if (onlineListener === undefined) {
        onlineListener = () => {
          removeOnlineListener();
          attemptLoad();
        };
        browserWindow.addEventListener("online", onlineListener, {
          once: true,
        });
      }

      return;
    }

    attempt += 1;
    tagState = "loading";
    telemetry("load-attempt");
    script = browserDocument.createElement("script");
    script.async = true;
    script.dataset.absoluteAttribution = "google-ads";
    script.src = `${GTAG_SRC}?id=${encodeURIComponent(options.id)}`;
    script.addEventListener(
      "load",
      () => {
        if (closed) return;
        tagState = "ready";
        telemetry("ready");
      },
      { once: true },
    );
    script.addEventListener(
      "error",
      () => {
        if (closed) return;
        script?.remove();
        script = undefined;
        if (attempt >= maxAttempts) {
          tagState = "failed";
          telemetry("failed");

          return;
        }
        tagState = "idle";
        telemetry("retry-scheduled");
        const delay =
          retryDelays[Math.min(attempt - 1, retryDelays.length - 1)] ?? 0;
        retryTimer = setTimeout(attemptLoad, delay);
      },
      { once: true },
    );
    browserDocument.head.appendChild(script);
  };

  return {
    close: () => {
      if (closed) return;
      closed = true;
      tagState = "closed";
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      removeOnlineListener();
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

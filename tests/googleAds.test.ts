import { describe, expect, test } from "bun:test";
import { createAttributionStore, type AttributionStorage } from "../src";
import {
  createGoogleAdsTag,
  sendGoogleAdsDataManagerConversion,
  type GoogleTagTelemetry,
} from "../src/googleAds";

const consent = {
  adPersonalization: "denied" as const,
  adStorage: "denied" as const,
  adUserData: "denied" as const,
  analyticsStorage: "denied" as const,
};

const memoryStorage = (): AttributionStorage => {
  const values = new Map<string, string>();

  return {
    getItem: (key) => values.get(key) ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
};

type FakeScript = EventTarget & {
  async: boolean;
  dataset: Record<string, string>;
  remove: () => void;
  src: string;
};

const fakeScript = (): FakeScript => {
  const script = new EventTarget() as FakeScript;
  script.async = false;
  script.dataset = {};
  script.remove = () => undefined;
  script.src = "";

  return script;
};

type FakeDocument = EventTarget & {
  createElement: () => FakeScript;
  head: { appendChild: (script: FakeScript) => void };
  visibilityState: DocumentVisibilityState;
};

const browser = (
  online = true,
  visibilityState: DocumentVisibilityState = "visible",
) => {
  const scripts: FakeScript[] = [];
  const browserWindow = new EventTarget() as EventTarget & {
    dataLayer?: IArguments[];
    gtag?: (...args: unknown[]) => void;
    navigator: { onLine: boolean };
  };
  browserWindow.navigator = { onLine: online };
  const browserDocument = new EventTarget() as FakeDocument;
  browserDocument.visibilityState = visibilityState;
  browserDocument.createElement = () => {
    const script = fakeScript();
    script.remove = () => {
      const index = scripts.indexOf(script);
      if (index >= 0) scripts.splice(index, 1);
    };

    return script;
  };
  browserDocument.head = {
    appendChild: (script: FakeScript) => scripts.push(script),
  };

  return {
    document: browserDocument as unknown as Document,
    rawDocument: browserDocument,
    rawWindow: browserWindow,
    scripts,
    window: browserWindow as unknown as Window,
  };
};

describe("resilient Google tag", () => {
  test("becomes ready only after the script load event", () => {
    const environment = browser();
    const events: GoogleTagTelemetry[] = [];
    const controller = createGoogleAdsTag({
      consent,
      id: "AW-test",
      onTelemetry: (event) => events.push(event),
      window: environment.window,
      document: environment.document,
    });
    controller.start();
    const script = environment.scripts[0]!;

    expect(controller.state()).toBe("loading");
    script.dispatchEvent(new Event("load"));
    expect(controller.state()).toBe("ready");
    expect(events.map((event) => event.event)).toEqual([
      "load-attempt",
      "ready",
    ]);
  });

  test("retries failures and reports recovery without exposing the click ID", async () => {
    const environment = browser();
    const storage = memoryStorage();
    const attribution = createAttributionStore({ storage });
    attribution.capture("https://example.com/?gclid=private-click-id");
    const events: GoogleTagTelemetry[] = [];
    const controller = createGoogleAdsTag({
      attribution,
      consent,
      id: "AW-test",
      onTelemetry: (event) => events.push(event),
      retryDelaysMs: [0],
      window: environment.window,
      document: environment.document,
    });
    controller.start();
    environment.scripts[0]!.dispatchEvent(new Event("error"));
    await Bun.sleep(1);
    environment.scripts[0]!.dispatchEvent(new Event("load"));

    expect(controller.state()).toBe("ready");
    expect(events.at(-1)).toMatchObject({
      attempt: 2,
      event: "ready",
      hadGoogleClickId: true,
      recovered: true,
    });
    expect(events[1]).toMatchObject({
      attempt: 1,
      event: "retry-scheduled",
      failureReason: "network-or-client-blocked",
      resourceTiming: { entryFound: false },
    });
    expect(JSON.stringify(events)).not.toContain("private-click-id");
  });

  test("waits for the browser to come online", () => {
    const environment = browser(false);
    const controller = createGoogleAdsTag({
      consent,
      id: "AW-test",
      window: environment.window,
      document: environment.document,
    });
    controller.start();
    expect(controller.state()).toBe("waiting-online");
    expect(environment.scripts).toHaveLength(0);

    environment.rawWindow.navigator.onLine = true;
    environment.rawWindow.dispatchEvent(new Event("online"));
    expect(controller.state()).toBe("loading");
    expect(environment.scripts).toHaveLength(1);
  });

  test("waits until a hidden page is visible", () => {
    const environment = browser(true, "hidden");
    const events: GoogleTagTelemetry[] = [];
    const controller = createGoogleAdsTag({
      consent,
      id: "AW-test",
      onTelemetry: (event) => events.push(event),
      window: environment.window,
      document: environment.document,
    });
    controller.start();

    expect(controller.state()).toBe("waiting-visible");
    expect(environment.scripts).toHaveLength(0);
    environment.rawDocument.visibilityState = "visible";
    environment.rawDocument.dispatchEvent(new Event("visibilitychange"));
    expect(controller.state()).toBe("loading");
    expect(events.map((event) => event.event)).toEqual([
      "waiting-visible",
      "load-attempt",
    ]);
  });

  test("classifies terminal CSP failures and includes diagnostic context", async () => {
    const environment = browser();
    const events: GoogleTagTelemetry[] = [];
    const controller = createGoogleAdsTag({
      consent,
      id: "AW-test",
      maxAttempts: 3,
      onTelemetry: (event) => events.push(event),
      window: environment.window,
      document: environment.document,
    });
    controller.start();
    const violation = Object.assign(new Event("securitypolicyviolation"), {
      blockedURI: "https://www.googletagmanager.com/gtag/js?id=AW-test",
      effectiveDirective: "script-src-elem",
    });
    environment.rawDocument.dispatchEvent(violation);
    environment.scripts[0]!.dispatchEvent(new Event("error"));

    expect(events.at(-1)).toMatchObject({
      attempt: 1,
      consent,
      event: "failed",
      failureReason: "csp-blocked",
      hadExistingTag: false,
      online: true,
      visibilityState: "visible",
    });
    expect(events.at(-1)?.resourceTiming).toEqual({
      durationMs: 0,
      entryFound: false,
      responseStatus: 0,
      transferSize: 0,
    });
  });

  test("times out a stalled script instead of remaining loading forever", async () => {
    const environment = browser();
    const events: GoogleTagTelemetry[] = [];
    const controller = createGoogleAdsTag({
      consent,
      id: "AW-test",
      loadTimeoutMs: 1,
      maxAttempts: 1,
      onTelemetry: (event) => events.push(event),
      window: environment.window,
      document: environment.document,
    });
    controller.start();
    const stalledScript = environment.scripts[0]!;
    await Bun.sleep(5);

    expect(controller.state()).toBe("failed");
    expect(events.at(-1)).toMatchObject({
      event: "failed",
      failureReason: "load-timeout",
    });
    stalledScript.dispatchEvent(new Event("load"));
    expect(controller.state()).toBe("failed");
    expect(events.filter((event) => event.event === "failed")).toHaveLength(1);
  });

  test("does not spend a retry when the browser goes offline during loading", () => {
    const environment = browser();
    const events: GoogleTagTelemetry[] = [];
    const controller = createGoogleAdsTag({
      consent,
      id: "AW-test",
      maxAttempts: 1,
      onTelemetry: (event) => events.push(event),
      window: environment.window,
      document: environment.document,
    });
    controller.start();
    environment.rawWindow.navigator.onLine = false;
    environment.scripts[0]!.dispatchEvent(new Event("error"));
    expect(controller.state()).toBe("waiting-online");

    environment.rawWindow.navigator.onLine = true;
    environment.rawWindow.dispatchEvent(new Event("online"));
    expect(controller.state()).toBe("loading");
    expect(events.at(-1)).toMatchObject({ attempt: 1, event: "load-attempt" });
  });
});

describe("Google Data Manager conversion delivery", () => {
  test("sends a deduplicated web conversion with consent and click attribution", async () => {
    let request: RequestInit | undefined;
    const result = await sendGoogleAdsDataManagerConversion(
      {
        accessToken: async () => "access-token",
        accountId: "123",
        conversionActionId: "456",
        fetch: async (_url, init) => {
          request = init;

          return new Response(JSON.stringify({ requestId: "request-1" }), {
            status: 200,
          });
        },
      },
      {
        consent: { adPersonalization: "denied", adUserData: "granted" },
        conversionValue: 799,
        currency: "USD",
        eventTimestamp: "2026-08-03T00:00:00.000Z",
        identifiers: { gclid: "click-1" },
        transactionId: "purchase-1",
      },
    );

    expect(result.requestId).toBe("request-1");
    expect(request?.headers).toEqual({
      authorization: "Bearer access-token",
      "content-type": "application/json",
    });
    expect(JSON.parse(String(request?.body))).toMatchObject({
      consent: { adPersonalization: "DENIED", adUserData: "GRANTED" },
      destinations: [{ productDestinationId: "456" }],
      events: [
        {
          adIdentifiers: { gclid: "click-1" },
          conversionValue: 799,
          currency: "USD",
          eventSource: "WEB",
          transactionId: "purchase-1",
        },
      ],
    });
  });
});

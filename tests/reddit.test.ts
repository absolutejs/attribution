import { describe, expect, test } from "bun:test";
import { createRedditPixel } from "../src/reddit";

const browser = () => {
  type Script = EventTarget & {
    async: boolean;
    src: string;
    remove: () => void;
  };
  const scripts: Script[] = [];
  const calls: unknown[][] = [];
  const window = {} as Window & {
    rdt?: ((...args: unknown[]) => void) & {
      sendEvent?: (...args: unknown[]) => void;
      callQueue: unknown[][];
    };
  };
  const document = {
    createElement: () =>
      Object.assign(new EventTarget(), { async: false, src: "", remove() {} }),
    head: { appendChild: (script: Script) => scripts.push(script) },
  } as unknown as Document;
  const ready = () => {
    window.rdt!.sendEvent = (...args) => {
      calls.push(args);
    };
    scripts[0]!.dispatchEvent(new Event("load"));
  };
  return { window, document, scripts, calls, ready };
};

describe("Reddit Pixel", () => {
  test("SSR and empty IDs never load or queue conversions", async () => {
    const ssr = createRedditPixel({ id: "a2_test", consent: true });
    ssr.start();
    expect(await ssr.track("SignUp")).toBe(false);
    const env = browser();
    const empty = createRedditPixel({ ...env, id: "", consent: true });
    empty.start();
    expect(await empty.track("SignUp")).toBe(false);
    expect(env.scripts).toHaveLength(0);
  });

  test("denied consent never loads Reddit or replays denied events", async () => {
    const env = browser();
    const pixel = createRedditPixel({ ...env, id: "a2_test", consent: false });
    pixel.start();
    expect(await pixel.track("SignUp")).toBe(false);
    expect(env.scripts).toHaveLength(0);
    pixel.updateConsent(true);
    env.ready();
    expect(env.calls).toEqual([
      ["init", "a2_test", { useDecimalCurrencyValues: true }],
      ["track", "PageVisit", {}],
    ]);
  });

  test("multiple callers share one loader and one initial PageVisit", () => {
    const env = browser();
    const options = { ...env, id: "a2_test", consent: true };
    const pixel = createRedditPixel(options);
    expect(createRedditPixel(options)).toBe(pixel);
    pixel.start();
    pixel.start();
    expect(env.scripts).toHaveLength(1);
    expect(env.scripts[0]!.src).toBe(
      "https://www.redditstatic.com/ads/pixel.js",
    );
    env.ready();
    pixel.updateConsent(true);
    expect(env.calls.filter((call) => call[1] === "PageVisit")).toHaveLength(1);
    expect(() => createRedditPixel({ ...options, id: "a2_other" })).toThrow(
      "different Reddit pixel",
    );
  });

  test("does not take over an existing pixel", async () => {
    const env = browser();
    env.window.rdt = Object.assign(() => {}, { callQueue: [] });
    const previous = env.window.rdt;
    const pixel = createRedditPixel({ ...env, id: "a2_test", consent: true });
    expect(await pixel.track("SignUp")).toBe(false);
    expect(env.window.rdt).toBe(previous);
    expect(env.scripts).toHaveLength(0);
  });

  test("queues consented conversions only until SDK readiness and preserves metadata", async () => {
    const env = browser();
    const pixel = createRedditPixel({ ...env, id: "a2_test", consent: true });
    const metadata = {
      value: 49.95,
      currency: "USD",
      conversionId: "payment-1",
    };
    const result = pixel.track("Purchase", metadata);
    expect(env.window.rdt!.callQueue).toHaveLength(0);
    metadata.value = 100;
    env.ready();
    expect(await result).toBe(true);
    expect(env.calls[2]).toEqual([
      "track",
      "Purchase",
      { value: 49.95, currency: "USD", conversionId: "payment-1" },
    ]);
    expect(await pixel.track("Purchase", metadata)).toBe(false);
    expect(
      await pixel.track("Purchase", { ...metadata, conversionId: "payment-2" }),
    ).toBe(true);
  });

  test("withdrawal during download drops conversions and prevents initialization", async () => {
    const env = browser();
    const pixel = createRedditPixel({ ...env, id: "a2_test", consent: true });
    const result = pixel.track("SignUp");
    pixel.updateConsent(false);
    env.ready();
    expect(await result).toBe(false);
    expect(env.calls).toHaveLength(0);
    pixel.updateConsent(true);
    expect(env.calls.filter((call) => call[1] === "SignUp")).toHaveLength(0);
    expect(env.calls.filter((call) => call[1] === "PageVisit")).toHaveLength(1);
  });

  test("withdrawal after initialization disables cookies and blocks application events", async () => {
    const env = browser();
    const pixel = createRedditPixel({ ...env, id: "a2_test", consent: true });
    pixel.start();
    env.ready();
    pixel.updateConsent(false);
    expect(env.calls.at(-1)).toEqual(["disableFirstPartyCookies"]);
    expect(await pixel.track("Purchase", { value: 5 })).toBe(false);
  });

  test("blocked script settles queued conversions without throwing", async () => {
    const env = browser();
    const pixel = createRedditPixel({ ...env, id: "a2_test", consent: true });
    const result = pixel.track("SignUp");
    env.scripts[0]!.dispatchEvent(new Event("error"));
    expect(await result).toBe(false);
    expect(pixel.state()).toBe("failed");
    expect(await pixel.track("SignUp")).toBe(false);
  });

  test("load timeout bounds conversion waits and ignores a late load", async () => {
    const env = browser();
    const pixel = createRedditPixel({
      ...env,
      id: "a2_test",
      consent: true,
      loadTimeoutMs: 5,
    });
    expect(await pixel.track("Purchase")).toBe(false);
    env.ready();
    expect(env.calls).toHaveLength(0);
    expect(pixel.state()).toBe("failed");
  });

  test("close settles pending events and ignores late load", async () => {
    const env = browser();
    const pixel = createRedditPixel({ ...env, id: "a2_test", consent: true });
    const result = pixel.track("SignUp");
    pixel.close();
    env.ready();
    expect(await result).toBe(false);
    expect(env.calls).toHaveLength(0);
    expect(pixel.state()).toBe("closed");
  });

  test("rejects invalid monetary values and unnamed custom events", async () => {
    const env = browser();
    const pixel = createRedditPixel({ ...env, id: "a2_test", consent: true });
    for (const value of [NaN, Infinity, -1])
      expect(await pixel.track("Purchase", { value })).toBe(false);
    expect(await pixel.track("Custom")).toBe(false);
    expect(env.scripts).toHaveLength(0);
    expect(() =>
      createRedditPixel({
        ...browser(),
        id: "a2_test",
        consent: true,
        loadTimeoutMs: Infinity,
      }),
    ).toThrow();
  });
});

import { describe, expect, test } from "bun:test";
import {
  createAttributionStore,
  decorateAttributionUrl,
  readGoogleClickIdentifiers,
} from "../src";

const memoryStorage = () => {
  const values = new Map<string, string>();

  return {
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => void values.delete(key),
    setItem: (key: string, value: string) => void values.set(key, value),
  };
};

describe("click attribution", () => {
  test("captures only valid Google click identifiers", () => {
    expect(
      readGoogleClickIdentifiers(
        "https://example.com/?gclid=abc-123&wbraid=web_456&token=secret",
      ),
    ).toEqual({ gclid: "abc-123", wbraid: "web_456" });
  });

  test("persists identifiers without retaining the landing URL", () => {
    const storage = memoryStorage();
    const attribution = createAttributionStore({
      now: () => 1_000,
      storage,
    });
    attribution.capture("https://example.com/private/path?gclid=click-1");

    expect(attribution.read()).toEqual({
      capturedAt: 1_000,
      identifiers: { gclid: "click-1" },
    });
    expect(storage.getItem("absolute_attribution")).not.toContain(
      "/private/path",
    );
  });

  test("expires stale identifiers", () => {
    const storage = memoryStorage();
    let now = 1_000;
    const attribution = createAttributionStore({
      maxAgeMs: 100,
      now: () => now,
      storage,
    });
    attribution.capture("https://example.com/?gclid=click-1");
    now = 1_101;

    expect(attribution.read()).toBeNull();
  });

  test("decorates only allowlisted owned origins", () => {
    const identifiers = { gclid: "click-1" };
    expect(
      decorateAttributionUrl(
        "https://qualify.example.com/start?utm_source=site",
        identifiers,
        ["https://qualify.example.com"],
      ),
    ).toBe("https://qualify.example.com/start?utm_source=site&gclid=click-1");
    expect(
      decorateAttributionUrl("https://other.example.com/", identifiers, [
        "https://qualify.example.com",
      ]),
    ).toBe("https://other.example.com/");
  });
});

# @absolutejs/attribution

Privacy-aware attribution primitives for web applications:

- capture `gclid`, `gbraid`, and `wbraid` without persisting full landing URLs;
- forward identifiers only to explicitly allowlisted owned origins;
- load the Google tag through a retrying `idle → loading → ready/failed` state
  machine;
- keep consent and conversion commands queued while the tag recovers;
- emit identifier-free, classified load telemetry with lifecycle, consent, CSP,
  and resource-timing context; and
- supplement browser tag conversions through Google Data Manager using the same
  transaction ID for deduplication.

## Browser attribution

```ts
import { createAttributionStore } from "@absolutejs/attribution";
import { createGoogleAdsTag } from "@absolutejs/attribution/google-ads";

const attribution = createAttributionStore();
attribution.capture();

const google = createGoogleAdsTag({
  attribution,
  consent: {
    adPersonalization: "denied",
    adStorage: "denied",
    adUserData: "denied",
    analyticsStorage: "denied",
  },
  id: "AW-123",
  onTelemetry: (event) => console.info(event),
});

// Start after framework hydration/mount.
google.start();

const qualificationUrl = attribution.decorate("https://qualify.example.com", [
  "https://qualify.example.com",
]);
```

The loader waits for the page to be online and visible, applies a bounded
per-attempt timeout, and spaces retries over a longer window. Terminal telemetry
classifies CSP blocks, offline transitions, timeouts, and the browser's otherwise
opaque network-or-client-blocked failures. Cross-origin response details remain
restricted unless the resource opts into Resource Timing access.

## Durable Google conversion supplement

```ts
import { sendGoogleAdsDataManagerConversion } from "@absolutejs/attribution/google-ads";

await sendGoogleAdsDataManagerConversion(
  {
    accessToken: getGoogleAccessToken,
    accountId: process.env.GOOGLE_ADS_ACCOUNT_ID!,
    conversionActionId: process.env.GOOGLE_ADS_CONVERSION_ACTION_ID!,
  },
  {
    consent: { adPersonalization: "denied", adUserData: "denied" },
    eventTimestamp: new Date().toISOString(),
    identifiers: { gclid },
    transactionId: paymentTransactionId,
  },
);
```

The package never sends full landing URLs or click identifiers through its
telemetry callback. Server delivery requires an explicit access-token provider,
destination, consent state, and click identifier.

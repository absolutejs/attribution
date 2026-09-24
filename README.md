# @absolutejs/attribution

## Reddit Pixel

```ts
import { createRedditPixel } from "@absolutejs/attribution/reddit";

const reddit = createRedditPixel({ id: "a2_your_pixel", consent: false });
// Call after hydration, when the visitor grants marketing consent:
reddit.updateConsent(true); // Loads the SDK and sends one PageVisit.
await reddit.track("SignUp");
await reddit.track("Purchase", {
  conversionId: "payment-123", // Stable identifier from a confirmed payment.
  value: 49.95, // Major currency units, not cents.
  currency: "USD",
  itemCount: 1,
});
```

The `./reddit` entry point is framework-independent and SSR-safe. An empty ID
disables it. It loads no Reddit resources until consent is granted, drops events
created without consent, and discards queued events on withdrawal. Loading is
bounded by `loadTimeoutMs` (default 2 seconds); blocked or failed scripts resolve
tracking calls to `false` so checkout cannot wait indefinitely. `true` means the
event was handed to Reddit's SDK, not confirmed receipt by Reddit. A controller
sends one initial PageVisit; call `track("PageVisit")` for client-side navigation.
Conversions sharing an event name and conversion ID are deduplicated within the
controller's lifetime. A full page reload starts a new controller; reuse stable
conversion IDs and do not track purchases on unverified success-page visits.

One controller owns each browser window. Recreating it for the same ID returns
that controller; a different ID throws. An existing external `window.rdt` is
left untouched and this controller fails closed, preventing accidental takeover.
The adapter does not change Reddit account settings or supply customer matching
fields. Existing automatic event/metadata settings in Reddit still apply.

On consent withdrawal, persist the new choice, call `updateConsent(false)`, then
**reload the page if the SDK has loaded**. The controller stops its own events
and disables Reddit first-party cookies, but only a reload removes all of the
vendor's automatic listeners. `close()` cancels this controller's pending work;
it does not unload already executed vendor code. A failed/closed controller
stays disabled until reload, avoiding duplicate loaders or late replay.

Install on the pages you intend to measure. Standard events include PageVisit,
ViewContent, Search, AddToCart, AddToWishlist, Purchase, Lead, and SignUp. Custom
events use `track("Custom", { customEventName: "..." })`. Use source-tagged links
for attribution to individual organic Reddit conversations; the pixel alone
does not identify an originating conversation.

Sources: [Reddit Pixel](https://business.reddithelp.com/articles/Knowledge/reddit-pixel),
[manual events](https://business.reddithelp.com/articles/Knowledge/manual-conversion-events-with-the-reddit-pixel).

## Google attribution

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

## Reddit loading and conversion waits

The Reddit adapter allows up to 15 seconds for the SDK to load. A `track()`
caller waits at most two seconds by default, so signup and checkout can proceed.
After that short wait, consented events remain queued until the SDK loads or
the script deadline expires. Consent withdrawal, explicit load failure, and
`close()` discard the queue. Set `loadTimeoutMs` and `conversionWaitTimeoutMs`
separately to customize these deadlines. A `false` result can mean the caller
wait expired; a `true` result means SDK handoff, not confirmed network delivery.

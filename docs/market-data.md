# Market data feed

The Headlines dashboard has an optional, server-side Barchart OnDemand feed for the active Bursa Malaysia palm-oil and CBOT soybean-oil futures contracts. The dashboard shows quote snapshots and a compact 90-day daily close chart; TradingView remains the interactive chart/reference path.

## Enablement

Set both variables in the deployment environment:

- `BARCHART_ONDEMAND_API_KEY`: secret issued for the Barchart OnDemand account.
- `BARCHART_DATA_DISPLAY_ENABLED=true`: operator confirmation that the selected subscription and exchange permissions allow displaying the data in this app.

The app intentionally returns a disabled state if either value is missing. Do not set the display flag until provider/exchange terms, fees, and permitted audience are confirmed. A key by itself does not establish public display or redistribution rights. Never place the key in frontend code.

## Current symbols and behavior

- Palm oil: Barchart active-contract symbol `KO*0` (MDEX).
- Soybean oil: Barchart active-contract symbol `ZL*0` (CBOT).
- Quotes are cached per Node process for 60 seconds; daily history is cached for 15 minutes. Concurrent requests share an in-flight provider request.
- Provider requests have a seven-second timeout. If a refresh fails, a still-cached prior response may be returned and the API marks it stale. The exchange trade timestamp and the provider-reported quote mode (`R` real-time, `I` delayed, `D` end-of-day) are shown separately from the app query time.
- Caches are deliberately in memory: no new database lifecycle or migration is needed for this read-only display. Each app replica has its own cache; if the app is scaled to multiple replicas or traffic makes provider call volume material, move this cache to shared Redis/Postgres before expanding instruments or polling frequency.

The feed is a snapshot, not a trading terminal or an execution-grade stream. The dashboard must not label a quote “real-time” unless the provider response itself reports mode `R`.


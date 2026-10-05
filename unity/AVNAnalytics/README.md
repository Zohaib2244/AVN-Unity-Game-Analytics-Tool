# AVN Analytics Unity SDK

Thin client for the AVN Analytics ingest server. Requires **Unity 2020.1+** (uses `UnityWebRequest.result`). No dependencies.

## Install

Copy this whole folder into your project's `Assets/` (e.g. `Assets/AVNAnalytics/`).

## Quick test

1. Create an empty GameObject in a scene and add **AvnAnalyticsDemo**.
2. Set **Endpoint** to your server's ingest URL (`https://your-domain/v1/events`) and paste the game's API key (admin site, *API keys* page) into **Api Key**.
3. Press Play. Use the on-screen buttons; watch *Pending on disk* and *Last status*.
4. In the admin site's health view, confirm events arrive (platform will be `editor` in the Editor).

Persistence test: click **Simulate OFFLINE**, log some events (pending grows), stop Play (or kill the app), press Play again, click **Go ONLINE** — the old events are sent.

## Use in a game

**From the Inspector:** add **AVN Analytics Initializer** (*Add Component, AVN Analytics*) to a GameObject in your first scene and fill in Endpoint, Api Key and any other settings (for example **Flush Interval Minutes**, default 2). It initializes before your other scripts' `Awake`.

**From code:**

```csharp
using Avn.Analytics;

void Awake() {
    AvnAnalytics.Initialize(new AvnConfig {
        Endpoint = "https://your-domain/v1/events",
        ApiKey = "YOUR_GAME_KEY",
    });
}

AvnAnalytics.LogEvent("level_complete",
    new AvnParameter("level", 3),
    new AvnParameter("duration_seconds", 42.5),
    new AvnParameter("mode", "normal"));
```

Migrating from Firebase is a find-and-replace: `FirebaseAnalytics.LogEvent` → `AvnAnalytics.LogEvent`, `new Parameter(` → `new AvnParameter(`. Run both in parallel while you compare counts. `LogEvent(name, Dictionary<string, object>)` also works. Optional: `AvnAnalytics.SetUserId(id)`.

### Automatic events

Turn off with `AutoSessionEvents = false`.

| Event | When | Params |
| --- | --- | --- |
| `first_open` | Once per install | |
| `session_start` | Launch, or returning after the app was in the background more than 30 min | `session_number` (1 = first ever), `language`, `timezone_offset_minutes`, `device_model`, `os_version`, `device_type`, `screen_width`, `screen_height` |
| `session_end` | Logged when the **next** session starts | `duration_seconds` (foreground time), `session_number` |

Every event also gets a `seq` param, a counter that goes up within a session, for exact ordering (`seq` is reserved; a param with that name is ignored).

**Sessions and coming back.** Backgrounding the app does not end the session. If the player returns within 30 minutes (`SessionTimeoutSeconds`) it is the same `session_id`. `session_end` is written only when a new session begins, with the old `session_id` and a `client_ts` of the last time the app was known to be alive, so the time spent in the background is not counted. The SDK keeps the session clock in `state.json` (saved on pause, quit and every 30 s while playing), so a session left open by a killed or crashed app still gets its `session_end` on the next launch. `duration_seconds` is accurate to about 30 s in that case.

**Location.** The SDK sends no location data and needs no location permission. The server adds a `country` from the request IP (Cloudflare `CF-IPCountry`).

## How reliability works

- **Disk first.** Every event is appended to `persistentDataPath/avn_analytics/queue.jsonl` before anything else. A crash or kill loses nothing already logged (the OS-level flush happens per event; an fsync happens on pause/quit — only a power cut in between could lose the last few events).
- **Delete after ack.** A batch is removed only after the server returns 2xx. If the app dies mid-send, it is sent again on next launch; the server dedups on `event_id`. The ack is recorded in a small cursor file, and the queue file is compacted only occasionally.
- **One request at a time**, batches of 50 events (or ≤700 KB), flushed when full, every 2 minutes (`FlushIntervalMinutes`), on app pause, and on launch. Backlogs drain with a 1 s gap between batches.
- **Small uploads.** Bodies are gzipped (`CompressRequests`), and the shared context (user, device, session, app version, build, platform) is sent once per batch instead of on every event. Together that is about 40 bytes per event on the wire instead of about 380. A batch ends where the context changes (for example at a new session). If an older server answers 415 to gzip, the SDK switches to plain JSON by itself.
- **Failures:** network error / 5xx → exponential backoff 5 s → 5 min with jitter; `Retry-After` honored (429/503). 400/413 → the batch is halved until the bad event is isolated, then moved to `quarantine.jsonl`. 401/403/404/415 → retry every 30 min, events are kept.
- **Cap:** 10,000 events / 5 MB; oldest dropped first.
- **Clock skew:** the server's `server_ts` is used to measure device clock error (saved on device); later events have `client_ts` corrected if the clock is off by more than 10 s. Events logged before the first successful sync are not corrected. Disable with `CorrectClockSkew = false`.
- **Sanitizing:** invalid event names are fixed (`bad name!` → `bad_name_`), params capped at 50, strings at 1024 chars, `null`/NaN/Infinity params dropped, bools sent as 0/1 — so one sloppy call cannot get a batch rejected.

IDs: `device_id` is a random GUID created on first run (stored in `state.json`, not a hardware ID); `session_id` is a random GUID per session. Update your store privacy disclosures accordingly.

Threading: `LogEvent` is safe from any thread; `Initialize` must be called on the main thread.

## Files

| File | Purpose |
| --- | --- |
| `AvnAnalytics.cs` | Public static API |
| `AvnConfig.cs` | Settings (editable in the Inspector) |
| `AvnAnalyticsInitializer.cs` | Component that initializes the SDK from Inspector settings |
| `AvnParameter.cs` | Firebase-style parameter |
| `AvnClient.cs` | Event building, batching, retry/backoff, clock skew |
| `AvnEventQueue.cs` | Durable on-disk queue |
| `AvnJson.cs` | JSON writer |
| `AvnRunner.cs` | Hidden object forwarding Update/pause/quit |
| `AvnAnalyticsDemo.cs` | Test harness, safe to delete |

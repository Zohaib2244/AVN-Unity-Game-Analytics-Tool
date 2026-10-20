# Prompt: set up AVN events in a Unity game

Run this in the game's repository with any coding agent, with `avn_events_standard.json` and
`avn_events_standard.md` in the repository root. The website's **Event setup → Add AVN
Events** downloads all three with the tiers filled in. Everything between the lines is the
prompt.

---

You are adding AVN Analytics events to this Unity game. The contract is `avn_events_standard.json`
(AVN events standard, version 3). Follow it exactly. Two different games set up with this prompt
must produce the same event names, keys and enum values, so there is no room for your own naming,
extra events or "improvements".

Tiers to implement: **core, standard** (change this line to choose).

## Hard rules

1. Send only event names from the spec. Never invent one, even if the game has a feature the spec
   does not cover. List such features in the report instead.
2. For each state, send only the keys the spec lists for it, with the listed types. Booleans are
   int 0/1. The only extra keys allowed are up to 5 game extras on `LEVEL_ANALYSIS Started`.
3. Closed enums are sent exactly as written in the spec. Game vocabulary (screens, placements,
   tutorials, powerups, currencies, ECONOMY_ANALYSIS `DETAIL`, SCREEN_ANALYSIS `ACTION`) is built with the spec's
   `naming_rules`; prefer the spec's listed names whenever one fits.
4. Unknown values are omitted, never sent as `None`, `null`, `unknown` or `""`.
5. Never send player names, emails or typed text. Never send amounts outside `ECONOMY_ANALYSIS`.
6. Do not change gameplay, rewards, prices, ad timing or existing analytics (Firebase, ByteBrew,
   plugin events). Add calls beside them. Do not remove or rename existing events.
7. Do not send `session_start`, `session_end` or `first_open`; the AVN SDK does. Do not initialize
   the SDK if the game already does (`AVNGameAnalytics.Initialize()`).
8. Nothing per frame, per shot or per tile. No `Requested` ad state. No banners.
9. If a required parameter truly cannot be known in this game, omit it and list it in the report.
   Never fake a value.
10. Never edit, copy or re-implement anything under `Assets/AVNAnalytics/`. It is the SDK package and
    is overwritten when the package is updated. Use its helpers (step 4); all game-specific code goes
    in `Assets/AVNEvents/`.

## Procedure

Do these steps in order and do not skip any.

1. **Read** `avn_events_standard.json` fully. Check that the AVN SDK package is imported:
   `Assets/AVNAnalytics/Scripts/` holds `AVNGameAnalytics.cs`, and `Scripts/Events/` holds
   `AvnSender.cs`, `AvnAttempt.cs`, `AvnAds.cs`, `AvnMemory.cs` and `AvnRuntime.cs` (namespace
   `AVNAnalytics.Events`). Read all of them. If they are missing, stop and tell the user to import
   `AVNAnalytics.unitypackage` (website: Settings, Unity SDK). Find how the game calls
   `AVNGameAnalytics.Initialize()`.
2. **Inventory the game.** For every spec event and state in the chosen tiers, find the exact code
   location (file, class, method) where its trigger happens. Also collect the game vocabulary:
   every level flow, result screen, ad call site, currency change, tutorial, powerup, menu and
   popup, store callback and app focus/pause handler.
3. **Name the vocabulary** with the naming rules, before writing any event code. Write it down in
   the profile (step 7).
4. **Write `AvnEvents.cs`** in a new folder `Assets/AVNEvents/`. It is the only game-specific file.
   The package already does the heavy parts, so use its helpers and do not write your own:
   - `AvnSender.Send(name, state, params)` is the only exit for an event. It adds `STATE` and
     `LEVEL_NUMBER` and drops unknown values. Set `AvnSender.CurrentLevel` to a function returning
     the game's current 1-based level (or null).
   - `AvnAttempt` keeps the level attempt: `Begin(level)`, `EndWithResult()`, `EndWithoutResult()`,
     `TakeChoice(out info)`, `Revive()`, `NotePowerupUsed()`, `TakeRecovered(...)`. It owns the attempt
     id, the attempt number, active seconds and the force-close recovery. Set
     `AvnAttempt.ProgressProvider` to a function returning the board progress 0-100.
   - `AvnAds` keeps ad state per `AD_ID`: `Ask`, `Begin`, `Find`, `End`, the `TimedOut` and
     `NotReady` events. Set `AvnAds.IsReady` to a function telling whether the ad network has an ad of
     a format loaded.
   - `AvnMemory` keeps "first time on this install" flags (`FirstTime`) and timers (`StartTimer`,
     `StopTimer`) for tutorials, screens and FTUE.
   - `AvnRuntime` raises `Launched`, `Backgrounded`, `Foregrounded`, `Quitting`. The game sets
     `AvnRuntime.PurchaseActive` while a store dialog is open.

   Key names and enum strings exist only in `AvnEvents.cs`; game code passes structs and enums,
   never strings for keys. Complete the skeleton below with one method per event and state in the
   chosen tiers (`LevelStarted`, `LevelCompleted`, `AdShow`, `EconomyEarned`, `ScreenOpened`, ...).
   Name methods `<Event><State>` in PascalCase. Add one struct per shared parameter set in the spec,
   following the pattern of the ones given. The skeleton shows the pattern, not every key: take keys,
   types and required flags from the spec.

   ```csharp
   using System.Collections.Generic;
   using AVNAnalytics;
   using AVNAnalytics.Events;
   using UnityEngine;

   namespace AVNEvents
   {
       // Closed enums: the C# name is the exact string sent.
       public enum ChoiceAction { Next, DoubleReward, Restart, Revive, Home, Abandoned }
       public enum PayMethod { Ad, Coins, Free }
       public enum AdFormat { Interstitial, Rewarded, AppOpen }
       public enum AdFailReason { NotReady, ShowFailed, Timeout }
       // ... one enum per closed enum in the spec, same pattern.

       public static class AvnEvents
       {
           // Runs once at startup. Wire the game's values and the package's signals here.
           [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.BeforeSceneLoad)]
           static void Init()
           {
               AVNGameAnalytics.StandardVersion = 3;                     // the spec version above
               AvnSender.CurrentLevel = () => /* the game's current level, or null */ null;
               AvnAttempt.ProgressProvider = () => /* board progress 0-100 */ 0;
               AvnAds.IsReady = format => /* is an ad of this format loaded */ false;

               // AppLaunch, AppForeground and AdFailed are written like AppBackground and AdShow below.
               AvnRuntime.Launched += AppLaunch;
               AvnRuntime.Backgrounded += AppBackground;
               AvnRuntime.Foregrounded += AppForeground;
               AvnAds.TimedOut += ad => AdFailed(ad, AdFailReason.Timeout);
               AvnAds.NotReady += (format, placement, level) => { /* AD_ANALYSIS Failed, NotReady */ };
           }

           // Level attempts. Begin() makes the id and attempt number; the result closes the clock.
           public static void LevelStarted(int level /*, LevelSource source, game extras */)
           {
               AvnAttempt.Begin(level);
               AvnMemory.StartTimer("level");
               // Send("LEVEL_ANALYSIS", "Started", Progress(AvnAttempt.Current()) + spec keys + extras);
           }

           public static void LevelCompleted(/* spec result keys: MOVES, SKIP_OFFERED ... */)
           {
               if (!AvnAttempt.InProgress) return;                       // one result per attempt
               Send("LEVEL_ANALYSIS", "Completed", Result(AvnAttempt.EndWithResult()));
           }

           public static void LevelChoice(ChoiceAction action, PayMethod? method = null)
           {
               if (!AvnAttempt.TakeChoice(out AvnAttemptInfo info)) return;   // one Choice per result
               if (action == ChoiceAction.Revive) AvnAttempt.Revive();        // same attempt, back in play
               var p = new Dictionary<string, object> {
                   ["ATTEMPT_ID"] = info.Id, ["LEVEL_NUMBER"] = info.Level, ["ACTION"] = action.ToString() };
               if (method.HasValue) p["METHOD"] = method.Value.ToString();
               Send("LEVEL_ANALYSIS", "Choice", p);
           }

           // Ads. Ask() right before requesting an ad, Begin() when the network shows one.
           public static void AdAsk(AdFormat format, string placement) =>
               AvnAds.Ask(format.ToString(), placement, AvnAttempt.InProgress ? AvnAttempt.Level : (int?)null,
                   watchReady: format == AdFormat.Rewarded);

           public static AvnAd AdShow(AdFormat format, bool fallback = false)
           {
               AvnAd ad = AvnAds.Begin(format.ToString(), fallback);
               AvnAttempt.NoteAdShown();
               Send("AD_ANALYSIS", "Show", Ad(ad));
               return ad;
           }

           // App lifecycle comes from AvnRuntime; this file only turns it into events.
           static void AppBackground(AvnCause cause) => Send("APP_ANALYSIS", "Background", new Dictionary<string, object> {
               ["CAUSE"] = cause.ToString(), ["IN_LEVEL"] = AvnAttempt.InProgress ? 1 : 0 });

           static Dictionary<string, object> Progress(AvnAttemptInfo x) => new Dictionary<string, object> {
               ["ATTEMPT_ID"] = x.Id, ["ATTEMPT"] = x.Attempt, ["LEVEL_NUMBER"] = x.Level,
               ["SECONDS"] = x.Seconds, ["PROGRESS_PCT"] = x.ProgressPct };

           static Dictionary<string, object> Result(AvnAttemptInfo x)
           {
               var p = Progress(x);
               p["REVIVES"] = x.Revives; p["POWERUPS_USED"] = x.PowerupsUsed; p["ADS_SHOWN"] = x.AdsShown;
               return p;
           }

           static Dictionary<string, object> Ad(AvnAd x)
           {
               var p = new Dictionary<string, object> {
                   ["AD_ID"] = x.Id, ["FORMAT"] = x.Format, ["PLACEMENT"] = x.Placement };
               if (x.Fallback) p["FALLBACK"] = 1;
               if (x.Level.HasValue) p["LEVEL_NUMBER"] = x.Level.Value;
               return p;
           }

           // The only exit. Game code never calls AvnSender or AVNGameAnalytics directly.
           static void Send(string name, string state, Dictionary<string, object> p) =>
               AvnSender.Send(name, state, p);
       }
   }
   ```
5. **Call the sender** from the locations in step 2. Keep each call a single line where possible.
   Guard against duplicates: one result per attempt (until a revive), one `Choice` per result,
   one `Closed` or `Failed` per `AD_ID`, one terminal state per tutorial run, FTUE_ANALYSIS steps once per
   install.
6. **Handle the hard cases:**
   - Revive keeps the same `ATTEMPT_ID` and may produce another result.
   - On `AvnRuntime.Launched`, call `AvnAttempt.TakeRecovered(out info, out hadResult)`. If the
     previous run died inside an attempt (`hadResult` false), send `LEVEL_ANALYSIS Left` with
     `REASON=Killed`, `RECOVERED=1` and the saved attempt values. If it died with a result but no
     choice (`hadResult` true), send `LEVEL_ANALYSIS Choice` with `ACTION=Abandoned`. The
     `APP_ANALYSIS Launch` event takes `PREV_EXIT` from the same signal.
   - `SECONDS` (level) excludes time in background and in fullscreen ads; `AvnAttempt` already
     does this. Do not time levels yourself.
   - Ad callbacks may arrive out of order or not at all. Look the ad up with `AvnAds.Find`, close it
     with `AvnAds.End` and send `Closed` or `Failed` only when `End` returns true (a duplicate
     callback returns false). `AvnAds.TimedOut` fires after 180 seconds without a close: send
     `Failed` with `REASON=Timeout`.
   - A rewarded button pressed with no ad loaded: call `AvnAds.Ask(..., watchReady: true)` and send
     `AD_ANALYSIS Failed` with `REASON=NotReady` from `AvnAds.NotReady`.
   - `APP_ANALYSIS Background` and `Foreground` come from `AvnRuntime`; the cause is `Ad` while an
     ad is open and `Purchase` while `AvnRuntime.PurchaseActive` is true. Set that flag around every
     store dialog.
   - Tutorials, screens and FTUE steps: use `AvnMemory.StartTimer`/`StopTimer` for durations (a
     `StopTimer` that returns false drops a second terminal state) and `AvnMemory.FirstTime` for
     "once per install".
7. **Write the profile** `Assets/AVNEvents/avn-events-profile.json`, exactly in this shape:

   ```json
   {
     "standard_version": 3,
     "tiers": ["core", "standard"],
     "vocabulary": {
       "screens": [],
       "placements": [],
       "tutorials": [],
       "powerups": [],
       "currencies": [],
       "economy_details": [],
       "screen_actions": [],
       "level_extras": {}
     },
     "events": {
       "LEVEL_ANALYSIS": { "Started": { "status": "done", "where": "LevelManager.StartLevel" } }
     },
     "not_implemented": [
       { "event": "IAP_ANALYSIS", "state": "Purchased", "reason": "the game has no store" }
     ],
     "omitted_params": [
       { "event": "LEVEL_ANALYSIS", "param": "PROGRESS_PCT", "reason": "..." }
     ],
     "uncovered_features": [
       { "feature": "spin wheel", "covered_by": "ECONOMY_ANALYSIS SOURCE=gift and SCREEN_ANALYSIS spin_wheel" }
     ]
   }
   ```

   `events` lists every event and state of the chosen tiers, each with `status` `done`,
   `not_applicable` or `omitted` and `where` (Class.Method). List vocabulary values sorted
   alphabetically.
8. **Check your work** before finishing:
   - Search the code for `AVNGameAnalytics.LogEvent` and `AvnSender.Send`: outside the package
     (`Assets/AVNAnalytics/`) only `Assets/AVNEvents/AvnEvents.cs` may call them, and nothing under
     `Assets/AVNAnalytics/` may be modified.
   - Compare every event name, key and enum string in `AvnEvents.cs` against the spec, character
     by character.
   - Compile the project. If it has edit-mode tests, add one test per event method that checks the
     produced name, keys and values against the spec, and run them.
9. **Report** in this order: what was implemented (a table of event, state, location), the
   vocabulary, everything in `not_implemented`, `omitted_params` and `uncovered_features`, and
   what needs checking on a device (ads, purchases, background, force close during a level).

Do not commit, push or open a pull request unless asked.

---

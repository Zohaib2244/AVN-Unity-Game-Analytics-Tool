# Prompt: set up AVN events in a Unity game

Run this in the game's repository with any coding agent, with `standard.spec.json` and
`STANDARD.md` in the repository root. The website's **Event setup → Install the
standard** downloads all three with the tiers filled in. Everything between the lines is the
prompt.

---

You are adding AVN Analytics events to this Unity game. The contract is `standard.spec.json`
(AVN events standard, version 3). Follow it exactly. Two different games set up with this prompt
must produce the same event names, keys and enum values, so there is no room for your own naming,
extra events or "improvements".

Tiers to implement: **core, standard** (change this line to choose).

## Hard rules

1. Send only event names from the spec. Never invent one, even if the game has a feature the spec
   does not cover. List such features in the report instead.
2. For each state, send only the keys the spec lists for it, with the listed types. Booleans are
   int 0/1. The only extra keys allowed are up to 5 game extras on `LEVEL Started`.
3. Closed enums are sent exactly as written in the spec. Game vocabulary (screens, placements,
   tutorials, powerups, currencies, ECONOMY `DETAIL`, SCREEN `ACTION`) is built with the spec's
   `naming_rules`; prefer the spec's listed names whenever one fits.
4. Unknown values are omitted, never sent as `None`, `null`, `unknown` or `""`.
5. Never send player names, emails or typed text. Never send amounts outside `ECONOMY`.
6. Do not change gameplay, rewards, prices, ad timing or existing analytics (Firebase, ByteBrew,
   plugin events). Add calls beside them. Do not remove or rename existing events.
7. Do not send `session_start`, `session_end` or `first_open`; the AVN SDK does. Do not initialize
   the SDK if the game already does.
8. Nothing per frame, per shot or per tile. No `Requested` ad state. No banners.
9. If a required parameter truly cannot be known in this game, omit it and list it in the report.
   Never fake a value.

## Procedure

Do these steps in order and do not skip any.

1. **Read** `standard.spec.json` fully. Find the AVN SDK (`AvnAnalytics.LogEvent`) and how the game
   initializes it.
2. **Inventory the game.** For every spec event and state in the chosen tiers, find the exact code
   location (file, class, method) where its trigger happens. Also collect the game vocabulary:
   every level flow, result screen, ad call site, currency change, tutorial, powerup, menu and
   popup, store callback and app focus/pause handler.
3. **Name the vocabulary** with the naming rules, before writing any event code. Write it down in
   the profile (step 7).
4. **Write one sender** in a new folder `Assets/AVNEvents/`, using exactly the structure below.
   Key names and enum strings exist only in `AvnEvents.cs`; game code passes structs and enums,
   never strings for keys.
   - `AvnEvents.cs`: the skeleton below, completed with one method per event and state in the
     chosen tiers (`LevelStarted`, `LevelCompleted`, `AdShow`, `EconomyEarned`, `ScreenOpened`,
     ...). Name methods `<Event><State>` in PascalCase. Add one struct per shared parameter set in
     the spec, following the pattern of the ones given.
   - `AvnEventsState.cs`: what the events need to remember (current attempt, attempt counts, ads
     in progress, tutorial start times, screen open times, last exit), persisted with the game's
     save system or `PlayerPrefs` only when it changes, never per frame.

   ```csharp
   using System.Collections.Generic;
   using Avn.Analytics;

   namespace AVNEvents
   {
       // Closed enums: the C# name is the exact string sent.
       public enum LevelSource { Launch, Home, Next, Restart, Debug }
       public enum ChoiceAction { Next, DoubleReward, Restart, Revive, Home, Abandoned }
       public enum LeftReason { Home, Quit, Killed }
       public enum PayMethod { Ad, Coins, Free }
       public enum AdFormat { Interstitial, Rewarded, AppOpen }
       public enum AdFailReason { NotReady, ShowFailed, Timeout }
       // ... one enum per closed enum in the spec, same pattern.

       // Shared parameter sets from the spec. Optional fields are nullable and omitted when null.
       public struct LevelProgress
       {
           public string AttemptId; public int Attempt; public int LevelNumber;
           public float Seconds; public int ProgressPct;
       }

       public struct LevelResult
       {
           public LevelProgress Progress;
           public int Revives; public int PowerupsUsed; public int AdsShown;
           public int? Moves; public bool? SkipOffered;
       }

       public struct AdInfo
       {
           public string AdId; public AdFormat Format; public string Placement; public bool? Fallback;
       }

       public struct EconomyFlow
       {
           public string Currency; public int Amount; public int Balance;
           public string Source; public string Detail;   // Source: spec ECONOMY SOURCE value
       }

       public static class AvnEvents
       {
           // Set by the game whenever the current level changes; null when there is none.
           public static int? CurrentLevel;

           public static void LevelCompleted(LevelResult r) => Send("LEVEL", "Completed", Result(r));

           public static void LevelChoice(string attemptId, int level, ChoiceAction action,
               PayMethod? method = null)
           {
               var p = new Dictionary<string, object> {
                   ["ATTEMPT_ID"] = attemptId, ["LEVEL_NUMBER"] = level, ["ACTION"] = action.ToString() };
               if (method.HasValue) p["METHOD"] = method.Value.ToString();
               Send("LEVEL", "Choice", p);
           }

           public static void AdShow(AdInfo ad) => Send("AD", "Show", Ad(ad));

           static Dictionary<string, object> Progress(LevelProgress x) => new Dictionary<string, object> {
               ["ATTEMPT_ID"] = x.AttemptId, ["ATTEMPT"] = x.Attempt, ["LEVEL_NUMBER"] = x.LevelNumber,
               ["SECONDS"] = x.Seconds, ["PROGRESS_PCT"] = x.ProgressPct };

           static Dictionary<string, object> Result(LevelResult x)
           {
               var p = Progress(x.Progress);
               p["REVIVES"] = x.Revives; p["POWERUPS_USED"] = x.PowerupsUsed; p["ADS_SHOWN"] = x.AdsShown;
               if (x.Moves.HasValue) p["MOVES"] = x.Moves.Value;
               if (x.SkipOffered.HasValue) p["SKIP_OFFERED"] = x.SkipOffered.Value ? 1 : 0;
               return p;
           }

           static Dictionary<string, object> Ad(AdInfo x)
           {
               var p = new Dictionary<string, object> {
                   ["AD_ID"] = x.AdId, ["FORMAT"] = x.Format.ToString(), ["PLACEMENT"] = x.Placement };
               if (x.Fallback.HasValue) p["FALLBACK"] = x.Fallback.Value ? 1 : 0;
               return p;
           }

           // The only call to the SDK in the whole game.
           static void Send(string name, string state, Dictionary<string, object> p)
           {
               p["STATE"] = state;
               if (!p.ContainsKey("LEVEL_NUMBER") && CurrentLevel.HasValue) p["LEVEL_NUMBER"] = CurrentLevel.Value;
               var clean = new Dictionary<string, object>();
               foreach (var kv in p)
                   if (kv.Value != null && !(kv.Value is string s && s.Length == 0)) clean[kv.Key] = kv.Value;
               AvnAnalytics.LogEvent(name, clean);
           }
       }
   }
   ```
5. **Call the sender** from the locations in step 2. Keep each call a single line where possible.
   Guard against duplicates: one result per attempt (until a revive), one `Choice` per result,
   one `Closed` or `Failed` per `AD_ID`, one terminal state per tutorial run, FTUE steps once per
   install.
6. **Handle the hard cases:**
   - Revive keeps the same `ATTEMPT_ID` and may produce another result.
   - On launch, if the previous run died inside an attempt, send `LEVEL Left` with
     `REASON=Killed`, `RECOVERED=1` and the saved attempt values. If it died with a result but no
     choice, send `LEVEL Choice` with `ACTION=Abandoned`.
   - `SECONDS` (level) excludes time in background and in fullscreen ads.
   - Ad callbacks may arrive out of order or not at all; keep the ad state per `AD_ID`, and close
     it as `Failed` with `REASON=Timeout` after 180 seconds without `Closed`.
   - A rewarded button pressed with no ad loaded is `AD Failed` with `REASON=NotReady`.
   - `APP Background` caused by an ad or a purchase dialog has `CAUSE=Ad` or `CAUSE=Purchase`.
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
       "LEVEL": { "Started": { "status": "done", "where": "LevelManager.StartLevel" } }
     },
     "not_implemented": [
       { "event": "IAP", "state": "Purchased", "reason": "the game has no store" }
     ],
     "omitted_params": [
       { "event": "LEVEL", "param": "PROGRESS_PCT", "reason": "..." }
     ],
     "uncovered_features": [
       { "feature": "spin wheel", "covered_by": "ECONOMY SOURCE=gift and SCREEN spin_wheel" }
     ]
   }
   ```

   `events` lists every event and state of the chosen tiers, each with `status` `done`,
   `not_applicable` or `omitted` and `where` (Class.Method). List vocabulary values sorted
   alphabetically.
8. **Check your work** before finishing:
   - Search the code for every `AvnAnalytics.LogEvent` call: all of them must be inside
     `Assets/AVNEvents/`.
   - Compare every event name, key and enum string in `AvnEvents.cs` against the spec, character
     by character.
   - Compile the project. If it has edit-mode tests, add one test per event method that checks the
     produced name, keys and values against the spec, and run them.
9. **Report** in this order: what was implemented (a table of event, state, location), the
   vocabulary, everything in `not_implemented`, `omitted_params` and `uncovered_features`, and
   what needs checking on a device (ads, purchases, background, force close during a level).

Do not commit, push or open a pull request unless asked.

---

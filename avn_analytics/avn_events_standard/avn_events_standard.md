# AVN events standard — version 5

The shared analytics contract for AVN games. This file is the whole standard: there is no separate machine-readable copy.

Ten events, 29 states. A game sends only these names, with only these parameter keys. Each game then records its own vocabulary — screens, placements, powerups, its MOVES unit — in its own profile, not here.

## Conventions

| Rule | What it means |
| --- | --- |
| Event names | Exactly the names in this document. UPPER_SNAKE. A game never invents new event names. |
| Parameter keys | Exactly the keys listed for the state, UPPER_SNAKE. `BALANCE_<CURRENCY>` and `POWERUP_<NAME>` are the only generated keys. |
| State | Every event has `STATE`. Never `STAGE`, `STATUS`, or a value used as a key. |
| Closed enums | Values listed in an enum are PascalCase and exactly as written. |
| Game IDs | Game vocabulary — placements, screens, tutorials, powerups, currencies, level IDs — is lower_snake, built with the naming rules below. |
| Product IDs | The raw store product ID, unchanged. |
| Types | `int`, `float`, `string`, `bool`. A bool is sent as int 0 or 1. |
| Unknown values | Omit the parameter. Never send `None`, `none`, `null`, `unknown` or an empty string. |
| Durations | Raw seconds. Never pre-bucketed ranges. |
| Lists | Never several values in one parameter. |
| Nesting | Events are flat. An event never contains another event or an array of them. Events are linked by a shared key instead: `ATTEMPT_ID` for everything inside one level attempt, `AD_ID` for one ad, `PRODUCT` for one purchase. |
| Personal data | Never player names, emails or any text the player typed. |

## Common parameters

These ride along on events beyond the ones that list them.

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `STATE` | string | Yes | One of the states listed for the event. |
| `LEVEL_NUMBER` | int | When known | 1-based player-facing level the event concerns. On every event when the game has a current level. |
| `ATTEMPT_ID` | string | When inside a level attempt | The attempt the event happened during. Sent on **every** event while an attempt is open, whatever the event: `AD_ANALYSIS`, `POWERUP_ANALYSIS`, `ECONOMY_ANALYSIS`, `SCREEN_ANALYSIS`, `APP_ANALYSIS`, `TUTORIAL_ANALYSIS`. This is the join key: it turns the counts on a result (`POWERUPS_USED`, `ADS_SHOWN`) into the individual `POWERUP_ANALYSIS` and `AD_ANALYSIS` rows behind them. |

An attempt is **open** from its `LEVEL_ANALYSIS Started` until its `Choice` or `Left`, so the result screen, and any ad, revive or reward on it, still belongs to the attempt. Events after that `Choice` (an interstitial before the next level, the home screen) carry no `ATTEMPT_ID`.

## Naming rules

- **lower_snake** — Take the code identifier, drop the suffixes Screen, Panel, Popup, Window, View, Controller, Manager, Button; split CamelCase and digits; lowercase; join with `_`. So `RemoveAdsSubPanel` becomes `remove_ads_sub`.
- **Screens** — Use these names when the game has the screen: `main_menu`, `shop`, `settings`, `leaderboard`, `profile`, `spin_wheel`, `daily_gift`, `remove_ads`, `no_internet`, `item_unlock`, `powerup_popup`, `rate_us`. Otherwise apply lower_snake.
- **Tutorials** — `first_level` for the first-play tutorial, `powerup_<powerup>` for a powerup tutorial, `feature_<name>` for any other feature tutorial.
- **Placements** — `<where>_<what>`: `level_complete_x2`, `level_fail_revive`, `level_skip`, `powerup_<powerup>`, `shop_coins`, `daily_gift_x2`, `spin_wheel_extra`, `app_open`, `level_interstitial`, `unattributed`.
- **Powerups** — lower_snake of the powerup type: `extra_slot`, `shuffle`, `bomb`, `rockets`, `auto_shoot`.
- **Currencies** — lower_snake: `coins`, `gems`.

## Tiers

| Tier | Events |
| --- | --- |
| **core** | `LEVEL_ANALYSIS`, `AD_ANALYSIS`, `ECONOMY_ANALYSIS`, `APP_ANALYSIS`. Ship first. |
| **standard** | `TUTORIAL_ANALYSIS`, `POWERUP_ANALYSIS`, `SCREEN_ANALYSIS`, `IAP_ANALYSIS`, `PLAYER_ANALYSIS`. |
| **extended** | `DEVICE_ANALYSIS`. |

---

# LEVEL_ANALYSIS

**core** — One attempt at a level, joined by `ATTEMPT_ID`.

Two shared parameter blocks are referenced below.

**progress**

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `ATTEMPT_ID` | string | Yes | |
| `ATTEMPT` | int | Yes | |
| `LEVEL_NUMBER` | int | Yes | |
| `SECONDS` | float | Yes | Time in the level since Started; excludes background and fullscreen ads. Time on the pause menu counts. |
| `PROGRESS_PCT` | int | No | 0–100 share of the level's goal done. Optional since v5: `MOVES_START` and `MOVES_LEFT` carry the same thing in raw counts. Send it when the game has no countable unit. |
| `TIME_LEFT` | float | No | Seconds on the clock when the attempt ends. Omit when the level is untimed. |
| `MOVES_LEFT` | int | No | Same unit as `MOVES_START`, remaining when the attempt ends. |

**result** — all of *progress*, plus:

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `REVIVES` | int | Yes | |
| `POWERUPS_USED` | int | Yes | |
| `ADS_SHOWN` | int | Yes | `AD_ANALYSIS Show` events during this attempt. |
| `SKIP_OFFERED` | int | No | 1 when the result screen offers a skip. Offers on the result screen are flags here, never their own events. |

### Started

*The board is playable and the player can act.*

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `ATTEMPT_ID` | string | Yes | New random ID per attempt. |
| `ATTEMPT` | int | Yes | How many times this player started this level, including this one. |
| `LEVEL_NUMBER` | int | Yes | |
| `SOURCE` | string | Yes | `Launch`, `Home`, `Next`, `Restart`, `Debug` |
| `LEVEL_ID` | string | No | Content ID when levels loop or are reordered. |
| `LEVEL_TIME` | float | No | Seconds the player gets. Omit when the level is untimed. |
| `MOVES_START` | int | No | How much of the game's own countable unit the level starts with. Omit when the game has no countable unit. |

Up to 5 game-specific parameters (UPPER_SNAKE, scalar) may be added **here only**, and must be listed in the game's report.

### Completed

*The player wins, before result animations or ads.*

All of **result**.

### Failed

*The player loses, before result animations or ads.*

All of **result**, plus:

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `FAIL_REASON` | string | When the game can lose in more than one way | `OutOfTime`, `OutOfMoves`, `Other`. `OutOfMoves` is any dead end counted in MOVES: the allowance is gone, the board or tray is full, or no legal action is left. |

### Skipped

*The player skips the level (paid, ad or free).*

All of **result**.

### Restarted

*The player restarts the level from inside it (pause or settings menu).*

All of **progress**.

### Left

*The attempt ends without a result.*

All of **progress**, plus:

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `REASON` | string | Yes | `Home`, `Quit`, `Killed` |
| `RECOVERED` | int | No | 1 when sent on the next launch for an attempt the process died in. That event lands in a later session; it joins its attempt by `ATTEMPT_ID`, never by session. |

### Choice

*The player picks what happens after a result.*

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `ATTEMPT_ID` | string | Yes | The attempt whose result this follows, even when the action (`Restart`, `Next`) goes on to start a new attempt. |
| `LEVEL_NUMBER` | int | Yes | |
| `ACTION` | string | Yes | `Next`, `DoubleReward`, `Restart`, `Revive`, `Home`, `Abandoned`. Abandoned: the app closed or died before a choice. |
| `METHOD` | string | No | `Ad`, `Coins`, `Free`. For DoubleReward and Revive. |

### Rules

- Send each of Completed, Failed and Skipped at most once per result. A Revive continues the same attempt and may produce another result.
- So one `ATTEMPT_ID` can carry several results (Failed, revive, Failed, revive, Completed). Count attempts by distinct `ATTEMPT_ID`, fails by Failed events, and take an attempt's outcome from its last result. `ATTEMPT` does not change on a revive.
- On a later result of the same attempt, `SECONDS`, `REVIVES`, `POWERUPS_USED` and `ADS_SHOWN` are totals for the whole attempt so far, not since the revive. `TIME_LEFT` and `MOVES_LEFT` are what remains at the moment of that result.
- Two times, two questions. `SECONDS` is how long the player spent in the level. `LEVEL_TIME - TIME_LEFT` is how much of the level's clock was used, which is what "nearly ran out of time" means. They differ when the clock stops and `SECONDS` doesn't (the pause menu), or a revive adds time.
- Backgrounding is not Left; `APP_ANALYSIS` Background and Foreground cover it.
- Coins are never reported here; `ECONOMY_ANALYSIS` is the ledger.
- `MOVES_START` and `MOVES_LEFT` are one unit the game picks and names in its report: moves, piles, balls, waves. One unit per game, never two. Units used is `MOVES_START - MOVES_LEFT` and is never sent as its own parameter.
- A game with neither a timer nor a countable unit omits `LEVEL_TIME`, `MOVES_START` and their LEFT pairs, and sends `PROGRESS_PCT` instead.

---

# AD_ANALYSIS

**core** — One ad attempt, joined by `AD_ID`. Revenue and impressions come from the ad plugin.

**ad** — the shared block on all three states:

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `AD_ID` | string | Yes | |
| `ATTEMPT_ID` | string | When shown during a level attempt | Which ads made up `ADS_SHOWN` on that attempt's result. |
| `FORMAT` | string | Yes | `Interstitial`, `Rewarded`, `AppOpen` |
| `PLACEMENT` | string | Yes | lower_snake, see the placement naming rule. |
| `FALLBACK` | int | No | 1 when an interstitial stands in for a rewarded ad. |

### Show

*Immediately before the provider show call.*

All of **ad**.

### Closed

*The ad is dismissed.*

All of **ad**, plus:

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `SECONDS_ON_SCREEN` | float | Yes | |
| `REWARDED` | int | On the Rewarded format | 1 when the reward was granted. |

### Failed

*No ad was shown when the game wanted one, including a rewarded button pressed with no ad loaded.*

All of **ad**, plus:

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `REASON` | string | Yes | `NotReady`, `ShowFailed`, `Timeout` |

### Rules

- No Requested state.
- Banners are not tracked.
- Show is not proof of an impression; a missing Closed is not proof of a crash.

---

# ECONOMY_ANALYSIS

**core** — The ledger for every soft currency. The only place amounts appear.

### Earned / Spent

*A balance increases / decreases.*

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `CURRENCY` | string | Yes | lower_snake, see the currency naming rule. |
| `AMOUNT` | int | Yes | Positive. |
| `BALANCE` | int | Yes | After the change. |
| `SOURCE` | string | Yes | See below. |
| `DETAIL` | string | No | lower_snake game detail, such as the powerup bought or the product. |

`SOURCE` is a lower_snake closed set: `level_reward`, `level_reward_bonus`, `rewarded_ad`, `purchase`, `subscription`, `gift`, `refund`, `powerup`, `revive`, `skip_level`, `unlock`, `other`. `gift` covers daily gifts, spin wheels and chests.

---

# APP_ANALYSIS

**core** — Process lifecycle. Never creates SDK sessions.

### Launch

*Process start.*

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `PREV_EXIT` | string | No | `Quit`, `Background`, `Killed` — how the previous run ended: clean quit, closed by the OS while in background, or died in foreground. Omitted on first launch. |

### Background

*The app loses focus.*

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `CAUSE` | string | Yes | `Ad`, `Purchase`, `Player` |
| `IN_LEVEL` | int | Yes | |
| `SCREEN` | string | No | Current screen, SCREEN naming. |

### Foreground

*The app regains focus.*

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `CAUSE` | string | Yes | `Ad`, `Purchase`, `Player` |
| `AWAY_SECONDS` | float | Yes | |

---

# TUTORIAL_ANALYSIS

**standard** — Guided sequences.

**tutorial** — the shared block on all three states:

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `TUTORIAL` | string | Yes | See the tutorial naming rule. |
| `STEP` | int | No | Only for multi-step tutorials, 1-based. |

### Shown

*The sequence begins.* All of **tutorial**.

### Completed

*The player does the prompted action.* All of **tutorial**, plus:

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `SECONDS` | float | Yes | Wall time since Shown. |

### Interrupted

*Cancelled, lost its target or the app was left.* All of **tutorial**, plus:

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `SECONDS` | float | Yes | Wall time since Shown. |

### Rules

- Repeated hints after the tutorial is done are not new Shown events.

---

# POWERUP_ANALYSIS

**standard** — Powerup inventory and use.

### Obtained

*A successful grant.*

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `POWERUP` | string | Yes | |
| `AMOUNT` | int | Yes | |
| `SOURCE` | string | Yes | `Coins`, `RewardedAd`, `Purchase`, `Subscription`, `Gift`, `Other` |
| `ATTEMPT_ID` | string | When granted during a level attempt | Omitted for grants from the shop, a gift or any other out-of-level source. |

### Used

*A successful activation.*

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `POWERUP` | string | Yes | |
| `TRIGGER` | string | Yes | `Player`, `Tutorial` |
| `SECONDS_INTO_LEVEL` | float | No | |
| `ATTEMPT_ID` | string | When used during a level attempt | Which powerups made up `POWERUPS_USED` on that attempt's result. Omitted for a powerup used outside a level. |

---

# SCREEN_ANALYSIS

**standard** — Every menu and popup, one event name.

### Opened

*The screen becomes visible.*

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `SCREEN` | string | Yes | |
| `SOURCE` | string | No | Previous screen name, or `auto` when the game opened it by itself. |

### Interaction

*A meaningful button inside the screen.*

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `SCREEN` | string | Yes | |
| `ACTION` | string | Yes | lower_snake of the button: `play`, `buy`, `watch_ad`, `music_off`. |
| `ITEM` | string | No | lower_snake item or store product ID. |

### Closed

*The screen hides. Required for shop and offer popups; optional elsewhere.*

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `SCREEN` | string | Yes | |
| `SECONDS_OPEN` | float | Yes | |
| `CLOSED_BY` | string | No | `Purchased`, `WatchedAd`, `Dismissed`, `SentToShop`, `System` |

### Rules

- Gameplay and level result screens are covered by `LEVEL_ANALYSIS` and are never `SCREEN_ANALYSIS` events.

---

# IAP_ANALYSIS

**standard** — Store purchases, from existing store callbacks only.

**iap** — the shared block on all four states:

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `PRODUCT` | string | Yes | Raw store product ID. |
| `SCREEN` | string | No | |

### Clicked

*An enabled buy button.* All of **iap**.

### Purchased

*The store confirms a new sale.* All of **iap**, plus:

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `PRICE` | float | No | Local price from the store. |
| `PRICE_CURRENCY` | string | No | ISO code from the store. |

### Failed

*The store reports failure or cancel.* All of **iap**, plus:

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `REASON` | string | Yes | `Cancelled`, `StoreError` |

### SubActivated

*A new subscription starts.* All of **iap**.

### Rules

- Restores, renewals and refunds are not sent.

---

# PLAYER_ANALYSIS

**standard** — The player's state, once per SDK session after load.

### Snapshot

*Once per session, after the save is loaded.*

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `HIGHEST_LEVEL` | int | Yes | |
| `BALANCE_<CURRENCY>` | int | Yes | One key per currency, such as `BALANCE_COINS`. |
| `POWERUP_<NAME>` | int | No | Inventory per powerup, such as `POWERUP_EXTRA_SLOT`. |
| `HAS_PURCHASED` | int | No | |
| `SUB_ACTIVE` | int | No | |
| `ADS_REMOVED` | int | No | |

---

# DEVICE_ANALYSIS

**extended** — Hardware facts the SDK does not send.

### Snapshot

*Once per install and again when the app version or quality tier changes.*

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `TIER` | string | No | The game's own quality tier. |
| `RAM_MB` | int | Yes | |
| `CPU_CORES` | int | Yes | |
| `GPU_MB` | int | No | |
| `QUALITY_LEVEL` | int | No | |

---

## For the website

`session_start`, `session_end` and `first_open` come from the SDK and are never sent by the game. A player's first time on a level, first session and other first-time moments are read from this timeline; the game sends nothing extra for them.

Derived on the backend, not sent as events:

- session number and session seconds, from `session_start` and `client_ts`
- process runs, from `APP_ANALYSIS Launch` ordered by `seq`
- install age, from `first_open`
- time buckets and funnels over existing events

The level pages need only these moments. A game that follows the standard gets them mapped automatically; a game that does not maps its own events to them on the Mappings page.

| Concept | Event | Condition | Number |
| --- | --- | --- | --- |
| `session_start` | `session_start` | SDK event, automatic | |
| `level_started` | `LEVEL_ANALYSIS` | STATE = Started | `LEVEL_NUMBER` |
| `level_completed` | `LEVEL_ANALYSIS` | STATE = Completed | `LEVEL_NUMBER` |
| `level_failed` | `LEVEL_ANALYSIS` | STATE = Failed | `LEVEL_NUMBER` |
| `level_restarted` | `LEVEL_ANALYSIS` | STATE = Restarted, or ACTION = Restart | `LEVEL_NUMBER` |

Order events within a level by `seq`, not by `client_ts`. A level start and the interstitial that follows it can share a timestamp, and sorting by time alone makes the pair look reversed or missing.

## Changelog

### Version 5

| Change | Detail |
| --- | --- |
| `LEVEL_ANALYSIS.Started` | Added `LEVEL_TIME` and `MOVES_START`. |
| `LEVEL_ANALYSIS` progress and result states | Added `TIME_LEFT` and `MOVES_LEFT`, so Completed, Failed, Skipped, Restarted and Left all carry them. |
| `LEVEL_ANALYSIS.Failed` | Added `FAIL_REASON`. |
| `LEVEL_ANALYSIS.MOVES` | Removed. `MOVES_START - MOVES_LEFT` replaces it, so the count is never sent twice. |
| `LEVEL_ANALYSIS.PROGRESS_PCT` | Now optional. Was required on every progress and result state in v4. |
| `ATTEMPT_ID` | Promoted to a common parameter. Every event sent while an attempt is open (Started until Choice or Left) carries it, so `AD_ANALYSIS`, `POWERUP_ANALYSIS` and the rest join back to the attempt they happened in. |
| `POWERUP_ANALYSIS.Used` | `ATTEMPT_ID` required only during a level attempt. |
| Revives | Spelled out: several results per `ATTEMPT_ID`, totals cover the whole attempt, the last result is the outcome. |
| The standard itself | This file is the standard. The JSON copy is gone, and nothing on the website checks games against it; Mappings and the Dictionary show what a game really sends. |
| `FTUE_ANALYSIS` | Removed from the standard. Use `first_open` and the first session's events instead. |

**Compatibility.** New parameters are all optional, so a v4 game stays valid. Two breaks: `MOVES` is gone, and `FTUE_ANALYSIS` is no longer a standard event.

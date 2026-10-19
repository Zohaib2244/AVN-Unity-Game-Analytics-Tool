# AVN events standard (version 3)

The exact events, states and parameters AVN Analytics expects from a game. The machine-readable
copy is [`standard.spec.json`](standard.spec.json); in it, `"$ref"` inside `params` pulls in a
named set from the event's `shared_params`. To set up a game, give an AI agent
[`AGENT_PROMPT.md`](AGENT_PROMPT.md) together with the spec.

Everything here is closed: a game sends only these event names, only these keys, and only the
listed values for closed enums. Game vocabulary (screens, placements, tutorials, powerups,
currencies) is open but built with the [naming rules](#naming-rules), so two games name the same
thing the same way.

## Rules

| Thing | Rule |
| --- | --- |
| Event names | Exactly the 11 below, `UPPER_SNAKE`. A game never invents an event name. |
| Sub-type | Always `STATE`. Never `STAGE`, `STATUS`, or a value used as a key (`Started: 3`). |
| Parameter keys | Exactly the keys listed for that state. Only `BALANCE_<CURRENCY>` and `POWERUP_<NAME>` are generated. |
| Closed enums | `PascalCase`, exactly as written here. |
| Game vocabulary | `lower_snake`, built with the naming rules. |
| Product IDs | The raw store product ID. |
| Types | `int`, `float`, `string`; booleans are `int` 0 or 1. |
| Unknown | Omit the parameter. Never `None`, `none`, `null`, `unknown` or `""`. |
| Durations | Raw seconds. Never buckets such as `<=60`. |
| Lists | Never several values in one parameter. |
| Personal data | Never player names, emails or typed text. |
| Amounts | Only in `ECONOMY`. |

On every event: `STATE` (string) and `LEVEL_NUMBER` (int, 1-based, player-facing) whenever the
game has a current level.

The game never sends what the SDK or the website already has: `session_start`, `session_end` and
`first_open` (SDK), session number, session seconds, install age, process runs, time buckets.

## Tiers

| Tier | Events |
| --- | --- |
| core | `LEVEL`, `AD`, `ECONOMY`, `APP` |
| standard | `TUTORIAL`, `FTUE`, `POWERUP`, `SCREEN`, `IAP`, `PLAYER` |
| extended | `DEVICE` |

## Events

Key: **req** required, *opt* optional.

### LEVEL (core)

One attempt, joined by `ATTEMPT_ID`.

| STATE | When | Parameters |
| --- | --- | --- |
| `Started` | Board is playable | **ATTEMPT_ID** string, **ATTEMPT** int, **LEVEL_NUMBER** int, **SOURCE** `Launch` `Home` `Next` `Restart` `Debug`, *LEVEL_ID* string, up to 5 game extras |
| `Completed` | Win, before animations and ads | result set |
| `Failed` | Loss, before animations and ads | result set |
| `Skipped` | Player skips the level | result set |
| `Restarted` | Restart from inside the level | progress set |
| `Left` | Attempt ends without a result | progress set, **REASON** `Home` `Quit` `Killed`, *RECOVERED* int |
| `Choice` | Player picks after a result | **ATTEMPT_ID**, **LEVEL_NUMBER**, **ACTION** `Next` `DoubleReward` `Restart` `Revive` `Home` `Abandoned`, *METHOD* `Ad` `Coins` `Free` |

- Progress set: **ATTEMPT_ID** string, **ATTEMPT** int, **LEVEL_NUMBER** int, **SECONDS** float (active play, no background or ads), **PROGRESS_PCT** int 0–100.
- Result set: the progress set plus **REVIVES** int, **POWERUPS_USED** int, **ADS_SHOWN** int, *MOVES* int, *SKIP_OFFERED* int.

Each result is sent once; a `Revive` continues the attempt and may produce another result.
Backgrounding is not `Left`. `Abandoned` means the app closed or died before a choice. An offer
shown on every result screen is a flag on the result (`SKIP_OFFERED`), never its own event.

### AD (core)

One ad attempt, joined by `AD_ID`. Every state carries the ad set: **AD_ID** string, **FORMAT**
`Interstitial` `Rewarded` `AppOpen`, **PLACEMENT** string, *FALLBACK* int.

| STATE | When | Extra parameters |
| --- | --- | --- |
| `Show` | Just before the provider show call | — |
| `Closed` | Ad dismissed | **SECONDS_ON_SCREEN** float, **REWARDED** int (rewarded only) |
| `Failed` | No ad shown when wanted, including a rewarded button with no ad loaded | **REASON** `NotReady` `ShowFailed` `Timeout` |

No `Requested` state, no banners. Revenue and impressions come from the ad plugin.

### ECONOMY (core)

| STATE | Parameters |
| --- | --- |
| `Earned`, `Spent` | **CURRENCY** string, **AMOUNT** int (positive), **BALANCE** int (after), **SOURCE**, *DETAIL* string |

`SOURCE` is one of `level_reward` `level_reward_bonus` `rewarded_ad` `purchase` `subscription`
`gift` `refund` `powerup` `revive` `skip_level` `unlock` `other`. `gift` covers daily gifts, spin
wheels and chests. `DETAIL` names the specific thing (`extra_slot`, a product ID).

### APP (core)

| STATE | Parameters |
| --- | --- |
| `Launch` | *PREV_EXIT* `Quit` `Background` `Killed` (omitted on first launch) |
| `Background` | **CAUSE** `Ad` `Purchase` `Player`, **IN_LEVEL** int, *SCREEN* string |
| `Foreground` | **CAUSE** `Ad` `Purchase` `Player`, **AWAY_SECONDS** float |

### TUTORIAL (standard)

| STATE | Parameters |
| --- | --- |
| `Shown` | **TUTORIAL** string, *STEP* int |
| `Completed`, `Interrupted` | **TUTORIAL** string, *STEP* int, **SECONDS** float (wall time since Shown) |

### FTUE (standard)

| STATE | Parameters |
| --- | --- |
| `Reached` | **STEP** `loading_done` `consent_done` `board_visible` `first_input`, **STEP_INDEX** int (fixed 1–4), **SECONDS_SINCE_LAUNCH** float |

Once per install. Skip steps the game lacks; never renumber.

### POWERUP (standard)

| STATE | Parameters |
| --- | --- |
| `Obtained` | **POWERUP** string, **AMOUNT** int, **SOURCE** `Coins` `RewardedAd` `Purchase` `Subscription` `Gift` `Other` |
| `Used` | **POWERUP** string, **TRIGGER** `Player` `Tutorial`, *SECONDS_INTO_LEVEL* float |

### SCREEN (standard)

| STATE | Parameters |
| --- | --- |
| `Opened` | **SCREEN** string, *SOURCE* string (previous screen, or `auto`) |
| `Interaction` | **SCREEN** string, **ACTION** string, *ITEM* string |
| `Closed` | **SCREEN** string, **SECONDS_OPEN** float, *CLOSED_BY* `Purchased` `WatchedAd` `Dismissed` `SentToShop` `System` |

`Closed` is required for the shop and offer popups, optional elsewhere. Gameplay and result
screens are `LEVEL`, never `SCREEN`.

### IAP (standard)

All states carry **PRODUCT** (store ID) and *SCREEN*.

| STATE | Extra parameters |
| --- | --- |
| `Clicked` | — |
| `Purchased` | *PRICE* float, *PRICE_CURRENCY* string (ISO) |
| `Failed` | **REASON** `Cancelled` `StoreError` |
| `SubActivated` | — |

Restores, renewals and refunds are not sent.

### PLAYER (standard)

| STATE | Parameters |
| --- | --- |
| `Snapshot` | **HIGHEST_LEVEL** int, **BALANCE_&lt;CURRENCY&gt;** int each, *POWERUP_&lt;NAME&gt;* int each, *HAS_PURCHASED*, *SUB_ACTIVE*, *ADS_REMOVED* int |

Once per SDK session, after the save loads.

### DEVICE (extended)

| STATE | Parameters |
| --- | --- |
| `Snapshot` | **RAM_MB** int, **CPU_CORES** int, *TIER* string, *GPU_MB* int, *QUALITY_LEVEL* int |

Once per install and when the app version or quality tier changes.

## Naming rules

- **lower_snake from code:** drop the suffixes `Screen`, `Panel`, `Popup`, `Window`, `View`,
  `Controller`, `Manager`, `Button`; split CamelCase and digits; lowercase; join with `_`.
  `RemoveAdsSubPanel` → `remove_ads_sub`.
- **Screens:** use `main_menu`, `shop`, `settings`, `leaderboard`, `profile`, `spin_wheel`,
  `daily_gift`, `remove_ads`, `no_internet`, `item_unlock`, `powerup_popup`, `rate_us` when the
  game has that screen; otherwise apply lower_snake.
- **Tutorials:** `first_level`, `powerup_<powerup>`, `feature_<name>`.
- **Placements:** `<where>_<what>`: `level_complete_x2`, `level_fail_revive`, `level_skip`,
  `powerup_<powerup>`, `shop_coins`, `daily_gift_x2`, `spin_wheel_extra`, `app_open`,
  `level_interstitial`, `unattributed`.
- **Powerups and currencies:** lower_snake of the type: `extra_slot`, `shuffle`, `coins`, `gems`.

## What the website reads

| Dashboard concept | Event and condition | Level number |
| --- | --- | --- |
| Session start | `session_start` (SDK) | — |
| Level started | `LEVEL` with `STATE=Started` | `LEVEL_NUMBER` |
| Level completed | `LEVEL` with `STATE=Completed` | `LEVEL_NUMBER` |
| Level failed | `LEVEL` with `STATE=Failed` | `LEVEL_NUMBER` |
| Level restarted | `LEVEL` with `STATE=Restarted`, or `ACTION=Restart` | `LEVEL_NUMBER` |

The Event setup page suggests all of these automatically from the `STATE` and `ACTION` values.

## Changing the standard

Add a state or parameter to an existing event before anything else. A change in meaning or type
needs a new standard version. Never add an event name per game.

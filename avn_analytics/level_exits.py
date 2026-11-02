"""Why a session ended, in a few steady words that add up across players.

Worked out from the end of the session backwards, past what the game sends by itself: a level start,
a reward, a snapshot, the app going to the background. An ad still open when the session ended is
the reason even if a level start was logged after it, and the ad's Show and Closed are matched by
AD_ID. Events are read in seq order, as two of them can share a timestamp.

"Left ..." means the session's ending reached the server, so this is what happened. "Last seen ..."
means it hasn't: older SDKs keep the final events on the phone until the next launch, so a player
who never returns never delivers them, and all we can say is the last thing we heard.
"""

from .stories import _words, param_text

SDK_EVENTS = {"session_start", "session_end", "first_open"}
# Sent by the game by itself, so never why a session ended.
AUTOMATIC = {"ECONOMY_ANALYSIS", "APP_ANALYSIS", "PLAYER_ANALYSIS", "DEVICE_ANALYSIS"}
IN_LEVEL = "in the level"
AFTER_AD_SECONDS = 10  # an ad closed before a level start is the reason only this soon after


def _ad(params):
    value = (param_text(params, "FORMAT") or "").lower()
    if value.startswith("inter"):
        return "interstitial ad"
    if value.startswith("reward"):
        return "rewarded ad"
    if value.startswith("app"):
        return "app open ad"
    return f"{_words(value)} ad" if value else "an ad"


def _in_order(pairs):
    """seq order when every event has one (it can settle a timestamp tie), else as read."""
    numbered = all(isinstance(row["seq"], int | float) for row, _ in pairs)
    return sorted(pairs, key=lambda pair: pair[0]["seq"]) if numbered else pairs


def _sentence_case(text):
    return text[0].lower() + text[1:] if len(text) > 1 and text[1].islower() else text


def _background_cause(row, params):
    if row["name"] == "APP_ANALYSIS" and param_text(params, "STATE") == "Background":
        return param_text(params, "CAUSE") or ""
    return None


def _ad_closings(content, reader):
    """Ad -> position of its Closed or Failed: matched by AD_ID, else by format."""
    closed = {}
    for position, (row, _) in enumerate(content):
        if row["name"] != "AD_ANALYSIS":
            continue
        params = reader.params(row["params"])
        if param_text(params, "STATE") in ("Closed", "Failed"):
            key = param_text(params, "AD_ID") or param_text(params, "FORMAT")
            closed.setdefault(key, position)
    return closed


def _ad_reason(content, position, closed, cause, passed_start, reader):
    """What this ad event says about the ending, or None when it says nothing."""
    row = content[position][0]
    params = reader.params(row["params"])
    state, ad = param_text(params, "STATE"), _ad(params)
    key = param_text(params, "AD_ID") or param_text(params, "FORMAT")
    if state == "Show" and closed.get(key, -1) < position:
        # The app went away by the player's hand, so an ad that never reported closing isn't why.
        return None if cause == "Player" else f"during {ad}"
    if state == "Failed":
        return f"after {ad} failed to show"
    moment = content[-1][0]["ts"] - row["ts"]
    if passed_start and moment > AFTER_AD_SECONDS:
        return IN_LEVEL
    if state == "Closed" and param_text(params, "REWARDED") == "0":
        return f"after {ad}, no reward"
    return f"after {ad}"


def _action_reason(row, info, params, reader):
    """What a level, screen, tutorial or purchase event says about the ending."""
    name, state = row["name"], param_text(params, "STATE")
    screen = param_text(params, "SCREEN")
    if info and info[0] == "completed":
        return "after finishing the level"
    if info and info[0] == "failed":
        return "after failing the level"
    if name == "LEVEL_ANALYSIS":
        if state == "Choice":
            action = param_text(params, "ACTION")
            return f"after choosing {_words(action)}" if action else "after the result screen"
        if state == "Left":
            reason = param_text(params, "REASON")
            return f"after quitting the level ({_words(reason)})" if reason else "after quitting"
        if state == "End":
            return "after finishing the level"
    if name == "SCREEN_ANALYSIS" and screen:
        return f"after closing {_words(screen)}" if state == "Closed" else f"on {_words(screen)}"
    if name == "TUTORIAL_ANALYSIS":
        return "after the tutorial" if state == "Completed" else "during the tutorial"
    if name == "IAP_ANALYSIS":
        if state == "Clicked":
            return "during a purchase"
        return "after a failed purchase" if state == "Failed" else "after a purchase"
    return f"after {_sentence_case(reader.action(row))}"


def where_they_left(rows, reader):
    """The ending of one session's (row, level info) pairs, as words after "Left" or "Last seen"."""
    content = _in_order([pair for pair in rows if pair[0]["name"] not in SDK_EVENTS])
    if not content:
        return IN_LEVEL
    last = content[-1][0]
    cause = _background_cause(last, reader.params(last["params"]))
    if cause == "Purchase":
        return "during a purchase"
    if cause == "Ad":
        ads = [row for row, _ in content if row["name"] == "AD_ANALYSIS"]
        return f"during {_ad(reader.params(ads[-1]['params']))}" if ads else "during an ad"
    closed = _ad_closings(content, reader)
    passed_start = False
    for position in range(len(content) - 1, -1, -1):
        row, info = content[position]
        if info and info[0] in ("started", "restarted"):
            passed_start = True
        elif row["name"] == "AD_ANALYSIS":
            found = _ad_reason(content, position, closed, cause, passed_start, reader)
            if found:
                return found
        elif row["name"] not in AUTOMATIC and not reader.labeler.hidden(row["name"]):
            if passed_start:  # whatever came before the level start belongs to before the level
                return IN_LEVEL
            return _action_reason(row, info, reader.params(row["params"]), reader)
    return IN_LEVEL


def ending_arrived(rows, reader, later_session):
    """Did the session's ending reach the server? Returning delivers it, as does the app's own end.

    An old SDK writes session_end at the next launch, so having one means the player came back.
    """
    if later_session:
        return True
    last = _in_order(rows)[-1][0]
    if last["name"] == "session_end":
        return True
    return _background_cause(last, reader.params(last["params"])) is not None


def phrase(where, arrived):
    return f"{'Left' if arrived else 'Last seen'} {where}"

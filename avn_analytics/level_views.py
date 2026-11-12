"""Compact prepared Levels details, selected through an atomically published player map.

The summary contribution contains counts and exact samples only. Each player's detail record
is stored once per level, with a membership mask rather than copies for every group. Immutable
tokens let staging replace a player without changing the groups visible to existing readers.
"""

from uuid import uuid4

from . import journeys, readbudget

GROUP_LEVELS = 64

SCHEMA = """
CREATE TABLE IF NOT EXISTS analytics_group_tokens (
    view_key TEXT NOT NULL REFERENCES analytics_views(key) ON DELETE CASCADE,
    token TEXT NOT NULL, bytes INTEGER NOT NULL,
    PRIMARY KEY(view_key, token)
);
CREATE TABLE IF NOT EXISTS analytics_level_groups (
    view_key TEXT NOT NULL, token TEXT NOT NULL, bucket INTEGER NOT NULL, payload BLOB NOT NULL,
    PRIMARY KEY(view_key, token, bucket),
    FOREIGN KEY(view_key, token) REFERENCES analytics_group_tokens(view_key, token)
        ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS analytics_level_groups_bucket
    ON analytics_level_groups(view_key, bucket, token);
CREATE TABLE IF NOT EXISTS analytics_level_players (
    view_key TEXT NOT NULL REFERENCES analytics_views(key) ON DELETE CASCADE,
    player TEXT NOT NULL, token TEXT NOT NULL,
    PRIMARY KEY(view_key, player),
    FOREIGN KEY(view_key, token) REFERENCES analytics_group_tokens(view_key, token)
        ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS analytics_level_players_token
    ON analytics_level_players(view_key, token);
CREATE TABLE IF NOT EXISTS analytics_level_staging (
    view_key TEXT NOT NULL REFERENCES analytics_views(key) ON DELETE CASCADE,
    player TEXT NOT NULL, token TEXT NOT NULL,
    PRIMARY KEY(view_key, player),
    FOREIGN KEY(view_key, token) REFERENCES analytics_group_tokens(view_key, token)
        ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS analytics_level_staging_token
    ON analytics_level_staging(view_key, token);
"""


def compact_groups(groups):
    """[[membership mask, record], ...], preserving distinct first-exit/entry records."""
    records = []
    positions = {}
    for index, name in enumerate(journeys.LEVEL_GROUPS):
        if name not in groups:
            continue
        record = groups[name]
        identity = id(record)
        if identity not in positions:
            positions[identity] = len(records)
            records.append([1 << index, record])
        else:
            records[positions[identity]][0] |= 1 << index
    return records


def contribution(value):
    from .views import pack

    summary = {
        **value,
        "groups": {
            number: journeys.group_summary(groups) for number, groups in value["groups"].items()
        },
    }
    buckets = {}
    for number, groups in value["groups"].items():
        buckets.setdefault(number // GROUP_LEVELS, {})[number] = compact_groups(groups)
    details = [(bucket, pack(levels)) for bucket, levels in buckets.items()]
    return pack(summary), uuid4().hex, details


def contribution_bytes(item):
    _, player, part, _, token, details = item
    identity = len(str(player).encode())
    return (
        len(part)
        + identity
        + 256
        + len(token)
        + 256
        + identity
        + len(token)
        + 256
        + sum(len(payload) + 256 for _, payload in details)
    )


def publication_growth(connection, key):
    sizes = []
    for table in ("analytics_level_staging", "analytics_level_players"):
        sizes.append(
            connection.execute(
                f"SELECT coalesce(sum(length(CAST(player AS BLOB))+length(token)+256),0) "
                f"FROM {table} WHERE view_key=?",
                (key,),
            ).fetchone()[0]
        )
    return max(0, sizes[0] - sizes[1])


def store(connection, key, contributions, players):
    """Replace staging parts, retaining old published tokens until publication succeeds."""
    previous = [
        row[0]
        for row in connection.execute(
            "SELECT token FROM analytics_level_staging WHERE view_key=? AND player IN ("
            + ",".join("?" for _ in players)
            + ")",
            (key, *players),
        )
    ]
    connection.executemany(
        "DELETE FROM analytics_parts WHERE view_key=? AND player=?",
        ((key, player) for player in players),
    )
    connection.executemany(
        "DELETE FROM analytics_level_staging WHERE view_key=? AND player=?",
        ((key, player) for player in players),
    )
    for _, player, part, nrows, token, details in contributions:
        used = sum(len(payload) + 256 for _, payload in details)
        connection.execute("INSERT INTO analytics_group_tokens VALUES(?,?,?)", (key, token, used))
        connection.executemany(
            "INSERT INTO analytics_level_groups VALUES(?,?,?,?)",
            ((key, token, level, payload) for level, payload in details),
        )
        connection.execute(
            "INSERT INTO analytics_parts(view_key,player,part,nrows) VALUES(?,?,?,?) "
            "ON CONFLICT(view_key,player) DO UPDATE SET part=excluded.part, "
            "nrows=excluded.nrows",
            (key, player, part, nrows),
        )
        connection.execute(
            "INSERT INTO analytics_level_staging VALUES(?,?,?)", (key, player, token)
        )
    for token in previous:
        connection.execute(
            "DELETE FROM analytics_group_tokens WHERE view_key=? AND token=? "
            "AND NOT EXISTS (SELECT 1 FROM analytics_level_players WHERE view_key=? AND token=?)",
            (key, token, key, token),
        )


def publish(connection, key):
    """Called in the answer's fenced publication transaction, never between player batches."""
    if connection.execute(
        "SELECT 1 FROM analytics_parts p LEFT JOIN analytics_level_staging s "
        "ON s.view_key=p.view_key AND s.player=p.player "
        "WHERE p.view_key=? AND s.token IS NULL LIMIT 1",
        (key,),
    ).fetchone():
        raise ValueError("Prepared player details are incomplete")
    connection.execute("DELETE FROM analytics_level_players WHERE view_key=?", (key,))
    connection.execute(
        "INSERT INTO analytics_level_players SELECT view_key,player,token "
        "FROM analytics_level_staging "
        "WHERE view_key=?",
        (key,),
    )
    cleanup(connection, key)


def cleanup(connection, key):
    connection.execute(
        "DELETE FROM analytics_group_tokens WHERE view_key=? "
        "AND token NOT IN (SELECT token FROM analytics_level_staging WHERE view_key=?) "
        "AND token NOT IN (SELECT token FROM analytics_level_players WHERE view_key=?)",
        (key, key, key),
    )


def read_groups(connection, key, level):
    from .views import unpack

    groups = {name: [] for name in journeys.LEVEL_GROUPS}
    rows = connection.execute(
        "SELECT g.payload FROM analytics_level_groups g JOIN analytics_level_players p "
        "ON p.view_key=g.view_key AND p.token=g.token "
        "WHERE g.view_key=? AND g.bucket=? ORDER BY p.player",
        (key, level // GROUP_LEVELS),
    )
    for position, row in enumerate(rows):
        if position % 128 == 0:
            readbudget.check()
        for mask, record in unpack(row[0]).get(str(level), []):
            for index, name in enumerate(journeys.LEVEL_GROUPS):
                if mask & (1 << index):
                    groups[name].append(record)
    return groups

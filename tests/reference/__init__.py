"""Frozen copies of the dashboard query modules as they were before the analytics pipeline work
(avn_analytics/{insights,journeys,events,rules}.py at commit 445ea63).

The parity harness (tests/parity.py) compares the production code with these, so a faster
implementation must give exactly the answers the original one did. Do not edit them to make a
test pass: a difference is either a bug in the new code or a deliberate, documented change.
Only the imports were changed, and the level scans call their computation directly instead of
going through Storage.scans (the frozen code must not share the production read cache).
"""

"""Exercise the browser request contract without a browser or a frontend build step."""

import shutil
import subprocess
from pathlib import Path

import pytest


@pytest.mark.skipif(shutil.which("node") is None, reason="Node is needed to exercise browser JS")
def test_read_retries_are_bounded_and_writes_are_never_replayed():
    script = (Path(__file__).parents[1] / "avn_analytics/static/app.js").read_text()
    request = script[script.index("async function request(") : script.index("function skeleton(")]
    checks = """
import assert from 'node:assert/strict';
globalThis.setTimeout = callback => { callback(); return 0; };
const response = (status, body = {}) => ({
  ok: status >= 200 && status < 300, status,
  headers: {get: () => '5'}, json: async () => body,
});
let calls = [];
let replies = [];
globalThis.fetch = async (path, options) => {
  calls.push({path, options});
  return replies.shift();
};
replies = [response(503), response(200, {players: 3})];
assert.deepEqual(await request('/insights/players'), {players: 3});
assert.equal(calls.length, 2);

calls = [];
replies = [response(503, {detail: 'Storage temporarily unavailable'}), response(503)];
await assert.rejects(request('/insights/players'), error => error.status === 503);
assert.equal(calls.length, 2);

for (const method of ['POST', 'PUT', 'DELETE']) {
  calls = [];
  replies = [response(503, {detail: 'Storage temporarily unavailable'})];
  await assert.rejects(request('/dictionary', {method}), error => error.status === 503);
  assert.equal(calls.length, 1);
}
calls = [];
replies = [response(403, {detail: 'Forbidden'})];
await assert.rejects(request('/games'), error => error.status === 403);
assert.equal(calls.length, 1);

globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
await assert.rejects(request('/games'),
  error => error.status === 0 && error.message.includes('connection'));
globalThis.fetch = async () => {
  throw Object.assign(new Error('Cancelled'), {name:'AbortError'});
};
await assert.rejects(request('/games'), error => error.name === 'AbortError');
"""
    result = subprocess.run(
        [shutil.which("node"), "--input-type=module"],
        input=request + checks,
        text=True,
        capture_output=True,
        timeout=10,
    )
    assert result.returncode == 0, result.stderr

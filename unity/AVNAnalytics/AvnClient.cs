using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using UnityEngine;
using UnityEngine.Networking;

namespace Avn.Analytics
{
    [Serializable]
    internal sealed class AvnState
    {
        public string deviceId;
        public string userId;
        public double skewSeconds;
        public bool firstOpenLogged;
    }

    [Serializable]
    internal sealed class AvnResponse
    {
        public int accepted;
        public int duplicates;
        public string server_ts;
    }

    /// <summary>Event creation, persistence hand-off, batching, retry and backoff.</summary>
    internal sealed class AvnClient
    {
        internal readonly AvnConfig Config;
        readonly AvnEventQueue queue;
        readonly AvnState state;
        readonly string statePath;
        readonly System.Random random = new System.Random();
        readonly object stateGate = new object();
        MonoBehaviour host;

        readonly string appVersion, build, platform;
        string sessionId;
        DateTime? pausedAtUtc;

        // sending state (main thread only)
        bool inFlight;
        bool forceFlush;
        bool draining;
        float holdUntil;
        bool holdIsServerDirected;
        float nextSendAt;
        float nextTimerAt;
        float backoff;
        int batchLimit;
        string lastStatus = "idle";

        internal string DeviceId => state.deviceId;
        internal string SessionId => sessionId;
        internal string LastStatus => lastStatus;
        internal int PendingCount => queue.Count;

        internal AvnClient(AvnConfig config)
        {
            Config = config;
            string dir = Path.Combine(Application.persistentDataPath, "avn_analytics");
            Directory.CreateDirectory(dir);
            statePath = Path.Combine(dir, "state.json");
            state = LoadState();
            queue = new AvnEventQueue(dir, Mathf.Max(1, config.MaxQueuedEvents), Math.Max(1024, config.MaxQueueBytes), Debug);

            appVersion = Clean(config.AppVersion, Application.version, "0");
            build = Clean(config.Build, Application.buildGUID, "0");
            platform = Clean(config.Platform, DetectPlatform(), "unknown");
            batchLimit = Mathf.Clamp(config.BatchSize, 1, 500);
        }

        internal void Start(MonoBehaviour runner)
        {
            host = runner;
            NewSession();
            if (Config.AutoSessionEvents)
            {
                if (!state.firstOpenLogged)
                {
                    state.firstOpenLogged = true;
                    SaveState();
                    Log("first_open", null);
                }
                Log("session_start", null);
            }
            Flush(); // launch: send anything left over from earlier runs
        }

        // ------------------------------------------------------------ events

        internal void Log(string name, IDictionary<string, object> parameters)
        {
            string line = BuildEvent(name, parameters);
            if (queue.Append(line)) Debug("queued " + name + " (" + queue.Count + " pending)");
        }

        string BuildEvent(string name, IDictionary<string, object> parameters)
        {
            var sb = new StringBuilder(256);
            sb.Append("{\"event_id\":\"").Append(Guid.NewGuid().ToString()).Append("\",\"name\":");
            AvnJson.WriteString(sb, SanitizeName(name));
            sb.Append(",\"params\":{");
            if (parameters != null)
            {
                int written = 0;
                foreach (var kv in parameters)
                {
                    if (written >= 50) { Debug("more than 50 params on " + name + "; extras dropped"); break; }
                    if (string.IsNullOrEmpty(kv.Key)) continue;
                    int mark = sb.Length;
                    if (written > 0) sb.Append(',');
                    AvnJson.WriteString(sb, AvnJson.Truncate(kv.Key, 80));
                    sb.Append(':');
                    if (AvnJson.TryWriteParamValue(sb, kv.Value)) written++;
                    else { sb.Length = mark; Debug("param '" + kv.Key + "' dropped (null or non-finite)"); }
                }
            }
            sb.Append("}");
            string userId, deviceId = state.deviceId;
            double skew;
            lock (stateGate) { userId = state.userId; skew = state.skewSeconds; }
            if (!string.IsNullOrEmpty(userId)) { sb.Append(",\"user_id\":"); AvnJson.WriteString(sb, AvnJson.Truncate(userId, 128)); }
            sb.Append(",\"device_id\":"); AvnJson.WriteString(sb, deviceId);
            sb.Append(",\"session_id\":"); AvnJson.WriteString(sb, sessionId ?? "none");
            sb.Append(",\"app_version\":"); AvnJson.WriteString(sb, appVersion);
            sb.Append(",\"build\":"); AvnJson.WriteString(sb, build);
            sb.Append(",\"platform\":"); AvnJson.WriteString(sb, platform);
            DateTime ts = DateTime.UtcNow;
            if (Config.CorrectClockSkew && Math.Abs(skew) > 10) ts = ts.AddSeconds(skew);
            sb.Append(",\"client_ts\":\"").Append(ts.ToString("yyyy-MM-dd'T'HH:mm:ss.ffffff'Z'", CultureInfo.InvariantCulture)).Append("\"}");
            return sb.ToString();
        }

        static string SanitizeName(string name)
        {
            if (string.IsNullOrEmpty(name)) return "unnamed_event";
            var sb = new StringBuilder(name.Length);
            foreach (char c in name)
                sb.Append((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' ? c : '_');
            if (!((sb[0] >= 'a' && sb[0] <= 'z') || (sb[0] >= 'A' && sb[0] <= 'Z'))) sb.Insert(0, "e_");
            if (sb.Length > 80) sb.Length = 80;
            return sb.ToString();
        }

        internal void SetUserId(string userId)
        {
            lock (stateGate) state.userId = string.IsNullOrEmpty(userId) ? null : userId;
            SaveState();
        }

        void NewSession()
        {
            sessionId = Guid.NewGuid().ToString("N");
        }

        // ------------------------------------------------------------ lifecycle

        internal void OnPause(bool paused)
        {
            if (paused)
            {
                pausedAtUtc = DateTime.UtcNow;
                queue.SyncToDisk();
                Flush();
                return;
            }
            if (pausedAtUtc.HasValue && (DateTime.UtcNow - pausedAtUtc.Value).TotalSeconds > Config.SessionTimeoutSeconds)
            {
                NewSession();
                if (Config.AutoSessionEvents) Log("session_start", null);
            }
            pausedAtUtc = null;
            Flush();
        }

        internal void OnQuit()
        {
            queue.Close();
            SaveState();
        }

        /// <summary>Send everything pending, ignoring the timer and any client-side backoff.</summary>
        internal void Flush()
        {
            forceFlush = true;
            draining = true;
            if (!holdIsServerDirected) holdUntil = 0f;
            nextTimerAt = 0f;
        }

        // ------------------------------------------------------------ sending

        /// <summary>Called every frame by the runner.</summary>
        internal void Tick(float now)
        {
            if (inFlight || host == null) return;
            if (queue.Count == 0) { draining = false; forceFlush = false; return; }
            if (now < holdUntil || now < nextSendAt) return;

            bool due = draining || forceFlush || queue.Count >= batchLimit || now >= nextTimerAt;
            if (!due) return;

            if (Application.internetReachability == NetworkReachability.NotReachable)
            {
                lastStatus = "offline, waiting for network";
                nextSendAt = now + 5f; // not a failure: no backoff growth
                return;
            }
            host.StartCoroutine(SendOne());
        }

        IEnumerator SendOne()
        {
            inFlight = true;
            forceFlush = false;
            int count;
            string body = queue.PeekBatch(Mathf.Clamp(batchLimit, 1, 500), Config.MaxBatchBytes, out count);
            if (body == null) { inFlight = false; yield break; }

            DateTime sentAt = DateTime.UtcNow;
            using (var req = new UnityWebRequest(Config.Endpoint, UnityWebRequest.kHttpVerbPOST))
            {
                req.uploadHandler = new UploadHandlerRaw(Encoding.UTF8.GetBytes(body));
                req.downloadHandler = new DownloadHandlerBuffer();
                req.SetRequestHeader("Content-Type", "application/json");
                req.SetRequestHeader("X-API-Key", Config.ApiKey);
                req.timeout = Mathf.Max(1, Mathf.RoundToInt(Config.RequestTimeoutSeconds));

                yield return req.SendWebRequest();

                DateTime receivedAt = DateTime.UtcNow;
                HandleResult(req, count, sentAt, receivedAt);
            }
            inFlight = false;
        }

        void HandleResult(UnityWebRequest req, int count, DateTime sentAt, DateTime receivedAt)
        {
            float now = Time.unscaledTime;
            nextTimerAt = now + Mathf.Max(1f, Config.FlushIntervalSeconds);
            long code = req.responseCode;

            if (req.result == UnityWebRequest.Result.Success && code >= 200 && code < 300)
            {
                var resp = SafeParse(req.downloadHandler.text);
                queue.Advance(count);
                backoff = 0f;
                holdUntil = 0f;
                holdIsServerDirected = false;
                batchLimit = Mathf.Clamp(Config.BatchSize, 1, 500);
                nextSendAt = now + Mathf.Max(0f, Config.PaceGapSeconds);
                if (resp != null) UpdateSkew(resp.server_ts, sentAt, receivedAt);
                lastStatus = "OK sent=" + count + (resp != null ? " accepted=" + resp.accepted + " dup=" + resp.duplicates : "") + " pending=" + queue.Count;
                Debug(lastStatus);
                return;
            }

            if (req.result == UnityWebRequest.Result.ProtocolError)
            {
                float retryAfter = ParseRetryAfter(req);
                if (code == 400 || code == 413)
                {
                    if (count > 1)
                    {
                        // One bad event poisons the whole batch: halve until the culprit is alone.
                        batchLimit = Mathf.Max(1, count / 2);
                        nextSendAt = now;
                        lastStatus = "HTTP " + code + ", splitting batch to " + batchLimit;
                    }
                    else
                    {
                        queue.Quarantine(1);
                        lastStatus = "HTTP " + code + ": invalid event moved to quarantine.jsonl";
                        nextSendAt = now;
                    }
                    Debug(lastStatus + " " + Truncate(req.downloadHandler.text));
                    return;
                }
                if (code == 429)
                {
                    SetHold(now, Mathf.Max(retryAfter, 5f) + (float)random.NextDouble() * 3f, true);
                    lastStatus = "HTTP 429 rate limited, retry in " + (int)(holdUntil - now) + "s";
                }
                else if (code >= 500)
                {
                    float delay = NextBackoff();
                    SetHold(now, Mathf.Max(delay, retryAfter), retryAfter > 0f);
                    lastStatus = "HTTP " + code + " server error, retry in " + (int)(holdUntil - now) + "s";
                }
                else
                {
                    // 401/403 bad or disabled key, 404/415 misconfiguration: retry rarely, never discard.
                    SetHold(now, Mathf.Max(Config.AuthRetrySeconds, retryAfter), true);
                    lastStatus = "HTTP " + code + " (check ApiKey/Endpoint), retry in " + (int)(holdUntil - now) + "s";
                    UnityEngine.Debug.LogWarning("[AVN Analytics] " + lastStatus);
                }
                Debug(lastStatus);
                return;
            }

            // connection error, timeout, DNS, TLS...
            SetHold(now, NextBackoff(), false);
            lastStatus = "network error: " + req.error + ", retry in " + (int)(holdUntil - now) + "s";
            Debug(lastStatus);
        }

        void SetHold(float now, float seconds, bool serverDirected)
        {
            holdUntil = now + seconds;
            holdIsServerDirected = serverDirected;
            draining = false;
        }

        float NextBackoff()
        {
            backoff = backoff <= 0f ? Config.MinBackoffSeconds : Mathf.Min(backoff * 2f, Config.MaxBackoffSeconds);
            return backoff * (0.5f + 0.5f * (float)random.NextDouble()); // jitter: 50-100% of the step
        }

        static float ParseRetryAfter(UnityWebRequest req)
        {
            string h = req.GetResponseHeader("Retry-After");
            return float.TryParse(h, NumberStyles.Float, CultureInfo.InvariantCulture, out float s) && s > 0f ? Mathf.Min(s, 3600f) : 0f;
        }

        static AvnResponse SafeParse(string json)
        {
            try { return string.IsNullOrEmpty(json) ? null : JsonUtility.FromJson<AvnResponse>(json); }
            catch (Exception) { return null; }
        }

        /// <summary>skew = server time - device time at the middle of the round trip.</summary>
        void UpdateSkew(string serverTs, DateTime sentAt, DateTime receivedAt)
        {
            if (!Config.CorrectClockSkew || string.IsNullOrEmpty(serverTs)) return;
            if (!DateTimeOffset.TryParse(serverTs, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var server)) return;
            if ((receivedAt - sentAt).TotalSeconds > 10) return; // too slow to trust
            DateTime mid = sentAt.AddTicks((receivedAt - sentAt).Ticks / 2);
            double skew = (server.UtcDateTime - mid).TotalSeconds;
            bool changed;
            lock (stateGate)
            {
                changed = Math.Abs(skew - state.skewSeconds) > 5;
                if (changed) state.skewSeconds = skew;
            }
            if (changed) { Debug("clock skew now " + skew.ToString("F1", CultureInfo.InvariantCulture) + "s"); SaveState(); }
        }

        // ------------------------------------------------------------ state file

        AvnState LoadState()
        {
            AvnState s = null;
            try
            {
                if (File.Exists(statePath)) s = JsonUtility.FromJson<AvnState>(File.ReadAllText(statePath));
            }
            catch (Exception e) { Debug("state load failed: " + e.Message); }
            if (s == null) s = new AvnState();
            if (string.IsNullOrEmpty(s.deviceId))
            {
                s.deviceId = Guid.NewGuid().ToString("N"); // random per install, not a hardware id
                lock (stateGate) { WriteState(s); }
            }
            return s;
        }

        void SaveState() { lock (stateGate) WriteState(state); }

        void WriteState(AvnState s)
        {
            try { AvnFiles.AtomicWrite(statePath, JsonUtility.ToJson(s)); }
            catch (Exception e) { Debug("state save failed: " + e.Message); }
        }

        // ------------------------------------------------------------ helpers

        static string Clean(string preferred, string fallback, string last)
        {
            string v = !string.IsNullOrEmpty(preferred) ? preferred : fallback;
            if (string.IsNullOrEmpty(v)) v = last;
            return AvnJson.Truncate(v, 128);
        }

        static string DetectPlatform()
        {
            switch (Application.platform)
            {
                case RuntimePlatform.Android: return "android";
                case RuntimePlatform.IPhonePlayer: return "ios";
                case RuntimePlatform.WindowsEditor:
                case RuntimePlatform.OSXEditor:
                case RuntimePlatform.LinuxEditor: return "editor";
                default: return Application.platform.ToString().ToLowerInvariant();
            }
        }

        static string Truncate(string s) => string.IsNullOrEmpty(s) ? "" : (s.Length > 300 ? s.Substring(0, 300) : s);

        void Debug(string message)
        {
            if (Config.DebugLogging) UnityEngine.Debug.Log("[AVN Analytics] " + message);
        }
    }
}

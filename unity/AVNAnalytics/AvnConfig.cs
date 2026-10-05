using System;
using UnityEngine;

namespace Avn.Analytics
{
    /// <summary>
    /// Settings for the AVN Analytics SDK. Edit it in the Inspector on an AvnAnalyticsInitializer,
    /// or create one in code and pass it to AvnAnalytics.Initialize.
    /// </summary>
    [Serializable]
    public sealed class AvnConfig
    {
        [Header("Server")]
        [Tooltip("Full ingest URL, e.g. https://analytics.example.com/v1/events")]
        public string Endpoint = "";

        [Tooltip("Game API key from the admin site (sent as X-API-Key). An identifier, not a secret.")]
        public string ApiKey = "";

        [Header("Build info (leave empty to detect automatically)")]
        public string AppVersion;
        public string Build;
        public string Platform;

        [Header("Batching")]
        [Tooltip("Send as soon as this many events are pending (server max is 500).")]
        [Min(1)]
        public int BatchSize = 50;

        [Tooltip("Send pending events at least this often, in minutes. Events are also sent when a batch fills up and when the app is paused or launched.")]
        [Min(0.05f)]
        public float FlushIntervalMinutes = 2f;

        [Tooltip("Hard cap on one request body in bytes. Server limit is 1 MiB.")]
        public int MaxBatchBytes = 700 * 1024;

        [Tooltip("Gap between batches while draining a backlog, in seconds.")]
        public float PaceGapSeconds = 1f;

        public float RequestTimeoutSeconds = 20f;

        [Header("Retry")]
        public float MinBackoffSeconds = 5f;
        public float MaxBackoffSeconds = 300f;

        [Tooltip("How long to wait after 401/403/404/415 (bad key, disabled key, misconfiguration), in seconds.")]
        public float AuthRetrySeconds = 1800f;

        [Header("Disk queue")]
        public int MaxQueuedEvents = 10000;
        public long MaxQueueBytes = 5L * 1024 * 1024;

        [Header("Behaviour")]
        [Tooltip("Start a new session after the app was in the background this long, in seconds.")]
        public float SessionTimeoutSeconds = 1800f;

        [Tooltip("Log first_open (once per install), session_start and session_end automatically.")]
        public bool AutoSessionEvents = true;

        [Tooltip("Shift client_ts by the device clock error measured from server responses.")]
        public bool CorrectClockSkew = true;

        public bool DebugLogging = false;

        internal float FlushIntervalSeconds => Mathf.Max(3f, FlushIntervalMinutes * 60f);
    }
}

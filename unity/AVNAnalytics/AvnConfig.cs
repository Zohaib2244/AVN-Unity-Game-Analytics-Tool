namespace Avn.Analytics
{
    /// <summary>Settings for the AVN Analytics SDK. Create one and pass it to AvnAnalytics.Initialize.</summary>
    public sealed class AvnConfig
    {
        /// <summary>Full ingest URL, e.g. https://gameanalytics.avns.site/v1/events</summary>
        public string Endpoint = "https://gameanalytics.avns.site/v1/events";

        /// <summary>Game API key from the admin site (sent as X-API-Key). An identifier, not a secret.</summary>
        public string ApiKey = "";

        /// <summary>Optional overrides. Null/empty = detect automatically.</summary>
        public string AppVersion;
        public string Build;
        public string Platform;

        // ---- batching ----
        /// <summary>Send as soon as this many events are pending (server max is 500).</summary>
        public int BatchSize = 50;
        /// <summary>Send pending events at least this often.</summary>
        public float FlushIntervalSeconds = 30f;
        /// <summary>Hard cap on one request body. Server limit is 1 MiB.</summary>
        public int MaxBatchBytes = 700 * 1024;
        /// <summary>Gap between batches while draining a backlog.</summary>
        public float PaceGapSeconds = 1f;
        public float RequestTimeoutSeconds = 20f;

        // ---- retry ----
        public float MinBackoffSeconds = 5f;
        public float MaxBackoffSeconds = 300f;
        /// <summary>How long to wait after 401/403/404/415 (bad key, disabled key, misconfiguration).</summary>
        public float AuthRetrySeconds = 1800f;

        // ---- disk queue ----
        public int MaxQueuedEvents = 10000;
        public long MaxQueueBytes = 5L * 1024 * 1024;

        // ---- behaviour ----
        /// <summary>Start a new session after the app was in the background this long.</summary>
        public float SessionTimeoutSeconds = 1800f;
        /// <summary>Log first_open (once per install) and session_start automatically.</summary>
        public bool AutoSessionEvents = true;
        /// <summary>Shift client_ts by the device clock error measured from server responses.</summary>
        public bool CorrectClockSkew = true;
        public bool DebugLogging = false;
    }
}

using System.Collections.Generic;
using UnityEngine;

namespace Avn.Analytics
{
    /// <summary>
    /// Drop-in replacement for the FirebaseAnalytics.LogEvent pattern.
    ///
    ///   AvnAnalytics.Initialize(new AvnConfig { ApiKey = "..." });
    ///   AvnAnalytics.LogEvent("level_complete", new AvnParameter("level", 3), new AvnParameter("time", 42.5));
    /// </summary>
    public static class AvnAnalytics
    {
        static AvnClient client;

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.SubsystemRegistration)]
        static void ResetStatics() { client = null; }

        public static bool IsInitialized => client != null;
        public static AvnConfig Config => client?.Config;
        /// <summary>Events stored on disk and not yet acknowledged by the server.</summary>
        public static int PendingCount => client?.PendingCount ?? 0;
        public static string DeviceId => client?.DeviceId;
        public static string SessionId => client?.SessionId;
        /// <summary>Human-readable result of the last send attempt (for debugging UIs).</summary>
        public static string LastStatus => client?.LastStatus ?? "not initialized";

        /// <summary>Call once at startup (e.g. in the first scene's Awake). Safe to call again; later calls are ignored.</summary>
        public static void Initialize(AvnConfig config)
        {
            if (client != null) { Debug.LogWarning("[AVN Analytics] Already initialized."); return; }
            if (config == null || string.IsNullOrEmpty(config.ApiKey) || string.IsNullOrEmpty(config.Endpoint))
            {
                Debug.LogError("[AVN Analytics] Initialize needs a config with Endpoint and ApiKey. Analytics disabled.");
                return;
            }

            var go = new GameObject("AVN Analytics") { hideFlags = HideFlags.HideAndDontSave };
            Object.DontDestroyOnLoad(go);
            var runner = go.AddComponent<AvnRunner>();
            client = new AvnClient(config);
            runner.Client = client;
            client.Start(runner);
        }

        public static void LogEvent(string name) => LogEventInternal(name, null);

        public static void LogEvent(string name, params AvnParameter[] parameters)
        {
            Dictionary<string, object> dict = null;
            if (parameters != null && parameters.Length > 0)
            {
                dict = new Dictionary<string, object>(parameters.Length);
                foreach (var p in parameters)
                    if (!string.IsNullOrEmpty(p.Name)) dict[p.Name] = p.Value; // later duplicates win
            }
            LogEventInternal(name, dict);
        }

        /// <summary>Values may be string, bool, any integer type, float, double. Others are ToString()'d; null/NaN/Infinity are dropped.</summary>
        public static void LogEvent(string name, IDictionary<string, object> parameters) => LogEventInternal(name, parameters);

        static void LogEventInternal(string name, IDictionary<string, object> parameters)
        {
            if (client == null)
            {
                Debug.LogWarning("[AVN Analytics] LogEvent('" + name + "') before Initialize(); event dropped.");
                return;
            }
            client.Log(name, parameters);
        }

        /// <summary>Optional stable player id (saved on the device). Pass null to clear.</summary>
        public static void SetUserId(string userId) => client?.SetUserId(userId);

        /// <summary>Try to send everything pending right now (ignores the timer and client-side backoff).</summary>
        public static void Flush() => client?.Flush();
    }
}

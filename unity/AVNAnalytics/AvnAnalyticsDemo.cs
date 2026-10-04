using System.Collections.Generic;
using UnityEngine;

namespace Avn.Analytics
{
    /// <summary>
    /// Test harness. Add to an empty GameObject in a scene, fill in Api Key, press Play.
    /// Delete it when you are done testing; real games call AvnAnalytics.Initialize themselves.
    /// </summary>
    public sealed class AvnAnalyticsDemo : MonoBehaviour
    {
        [SerializeField] string endpoint = "https://analytics.example.com/v1/events";
        [SerializeField] string apiKey = "";
        [SerializeField] bool debugLogging = true;
        [Tooltip("Shorter than the default so you can watch it work.")]
        [SerializeField] float flushIntervalSeconds = 10f;

        string goodEndpoint;
        bool offline;
        int counter;

        void Awake()
        {
            goodEndpoint = endpoint;
            AvnAnalytics.Initialize(new AvnConfig
            {
                Endpoint = endpoint,
                ApiKey = apiKey,
                DebugLogging = debugLogging,
                FlushIntervalSeconds = flushIntervalSeconds,
            });
        }

        void OnGUI()
        {
            float scale = Mathf.Max(1f, Screen.dpi / 110f);
            GUIUtility.ScaleAroundPivot(new Vector2(scale, scale), Vector2.zero);
            GUILayout.BeginArea(new Rect(10, 10, Screen.width / scale - 20, Screen.height / scale - 20));

            GUILayout.Label("AVN Analytics demo");
            GUILayout.Label("Initialized: " + AvnAnalytics.IsInitialized);
            GUILayout.Label("Pending on disk: " + AvnAnalytics.PendingCount);
            GUILayout.Label("Last status: " + AvnAnalytics.LastStatus);
            GUILayout.Label("Device: " + AvnAnalytics.DeviceId);
            GUILayout.Label("Session: " + AvnAnalytics.SessionId);

            if (GUILayout.Button("Log level_complete")) 
                AvnAnalytics.LogEvent("level_complete",
                    new AvnParameter("level", ++counter),
                    new AvnParameter("duration_seconds", 42.5),
                    new AvnParameter("mode", "normal"));

            if (GUILayout.Button("Log purchase (dictionary params)"))
                AvnAnalytics.LogEvent("purchase", new Dictionary<string, object>
                {
                    { "item", "gem_pack_small" }, { "price_usd", 0.99 }, { "first_purchase", true }
                });

            if (GUILayout.Button("Log 100 events (batching)")) Burst(100);
            if (GUILayout.Button("Log 1500 events (backlog pacing)")) Burst(1500);

            if (GUILayout.Button("Log event with bad name/params (sanitizing)"))
                AvnAnalytics.LogEvent("bad name-with spaces!", new AvnParameter("ok", 1),
                    new AvnParameter("nan", double.NaN), new AvnParameter("", "empty key dropped"));

            if (GUILayout.Button("Flush now")) AvnAnalytics.Flush();

            if (GUILayout.Button(offline ? "Go ONLINE (restore endpoint)" : "Simulate OFFLINE (bad endpoint)"))
            {
                offline = !offline;
                AvnAnalytics.Config.Endpoint = offline ? "http://127.0.0.1:9/v1/events" : goodEndpoint;
            }

            GUILayout.Label("Persistence test: log events while OFFLINE, stop Play / kill the app, run again, go online.");
            GUILayout.EndArea();
        }

        void Burst(int n)
        {
            for (int i = 0; i < n; i++)
                AvnAnalytics.LogEvent("test_burst", new AvnParameter("i", i), new AvnParameter("batch", counter));
            counter++;
        }
    }
}

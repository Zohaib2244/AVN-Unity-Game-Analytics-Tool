using UnityEngine;

namespace Avn.Analytics
{
    /// <summary>Hidden persistent object that drives the client from Unity's lifecycle callbacks.</summary>
    internal sealed class AvnRunner : MonoBehaviour
    {
        internal AvnClient Client;

        void Update() { Client?.Tick(Time.unscaledTime); }
        void OnApplicationPause(bool paused) { Client?.OnPause(paused); }
        void OnApplicationQuit() { Client?.OnQuit(); }
    }
}

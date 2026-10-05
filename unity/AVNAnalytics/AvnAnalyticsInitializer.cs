using UnityEngine;

namespace Avn.Analytics
{
    /// <summary>
    /// Inspector-friendly setup: add to a GameObject in your first scene, fill in the settings,
    /// and AVN Analytics starts before other scripts' Awake. Only the first initializer that
    /// runs takes effect.
    /// </summary>
    [DefaultExecutionOrder(-1000)]
    [AddComponentMenu("AVN Analytics/AVN Analytics Initializer")]
    public sealed class AvnAnalyticsInitializer : MonoBehaviour
    {
        [SerializeField] AvnConfig config = new AvnConfig();

        void Awake()
        {
            if (!AvnAnalytics.IsInitialized) AvnAnalytics.Initialize(config);
        }
    }
}

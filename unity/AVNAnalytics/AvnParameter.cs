namespace Avn.Analytics
{
    /// <summary>Firebase-style event parameter: new AvnParameter("level", 3).</summary>
    public readonly struct AvnParameter
    {
        public readonly string Name;
        public readonly object Value;

        public AvnParameter(string name, string value) { Name = name; Value = value; }
        public AvnParameter(string name, long value) { Name = name; Value = value; }
        public AvnParameter(string name, int value) { Name = name; Value = (long)value; }
        public AvnParameter(string name, double value) { Name = name; Value = value; }
        public AvnParameter(string name, float value) { Name = name; Value = (double)value; }
        public AvnParameter(string name, bool value) { Name = name; Value = value ? 1L : 0L; }
    }
}

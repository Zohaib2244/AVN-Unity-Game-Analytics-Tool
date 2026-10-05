using System;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Text;

namespace Avn.Analytics
{
    /// <summary>Minimal JSON writer (JsonUtility cannot serialize dictionaries).</summary>
    internal static class AvnJson
    {
        internal static void WriteString(StringBuilder sb, string s)
        {
            sb.Append('"');
            foreach (char c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    case '\b': sb.Append("\\b"); break;
                    case '\f': sb.Append("\\f"); break;
                    default:
                        if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                        else sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
        }

        /// <summary>Truncates to at most max UTF-16 units without splitting a surrogate pair.</summary>
        internal static string Truncate(string s, int max)
        {
            if (s.Length <= max) return s;
            int cut = max;
            if (char.IsHighSurrogate(s[cut - 1])) cut--;
            return s.Substring(0, cut);
        }

        /// <summary>Writes a string or finite number. Returns false (writing nothing) for unsupported values.</summary>
        internal static bool TryWriteParamValue(StringBuilder sb, object v)
        {
            if (v == null) return false;
            string str = v as string;
            if (str != null) { WriteString(sb, Truncate(str, 1024)); return true; }
            if (v is bool) { sb.Append((bool)v ? '1' : '0'); return true; }
            if (v is sbyte || v is byte || v is short || v is ushort || v is int || v is uint || v is long)
            {
                sb.Append(Convert.ToInt64(v, CultureInfo.InvariantCulture).ToString(CultureInfo.InvariantCulture));
                return true;
            }
            if (v is ulong)
            {
                ulong u = (ulong)v;
                if (u <= long.MaxValue) sb.Append(((long)u).ToString(CultureInfo.InvariantCulture));
                else sb.Append(((double)u).ToString("R", CultureInfo.InvariantCulture));
                return true;
            }
            if (v is float)
            {
                float f = (float)v;
                if (float.IsNaN(f) || float.IsInfinity(f)) return false;
                sb.Append(f.ToString("R", CultureInfo.InvariantCulture));
                return true;
            }
            if (v is double)
            {
                double d = (double)v;
                if (double.IsNaN(d) || double.IsInfinity(d)) return false;
                sb.Append(d.ToString("R", CultureInfo.InvariantCulture));
                return true;
            }
            if (v is decimal) { sb.Append(((decimal)v).ToString(CultureInfo.InvariantCulture)); return true; }
            WriteString(sb, Truncate(v.ToString() ?? "", 1024));
            return true;
        }
    }

    internal static class AvnGzip
    {
        internal static byte[] Compress(byte[] data)
        {
            using (var output = new MemoryStream())
            {
                using (var gzip = new GZipStream(output, CompressionMode.Compress, true))
                    gzip.Write(data, 0, data.Length);
                return output.ToArray();
            }
        }
    }
}

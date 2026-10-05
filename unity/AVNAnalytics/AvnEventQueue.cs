using System;
using System.Collections.Generic;
using System.IO;
using System.Text;

namespace Avn.Analytics
{
    internal static class AvnFiles
    {
        /// <summary>Write-then-rename so a crash never leaves a half-written file at path.</summary>
        internal static void AtomicWrite(string path, string text)
        {
            string tmp = path + ".tmp";
            using (var fs = new FileStream(tmp, FileMode.Create, FileAccess.Write, FileShare.None))
            {
                byte[] bytes = new UTF8Encoding(false).GetBytes(text);
                fs.Write(bytes, 0, bytes.Length);
                fs.Flush(true);
            }
            Replace(tmp, path);
        }

        internal static void Replace(string tmp, string path)
        {
            if (!File.Exists(path)) { File.Move(tmp, path); return; }
            try { File.Replace(tmp, path, null); }
            catch (Exception)
            {
                File.Delete(path);
                File.Move(tmp, path);
            }
        }
    }

    /// <summary>
    /// Durable FIFO of serialized events, one JSON object per line.
    ///
    /// queue.jsonl   first line "#&lt;fileId&gt;", then one event per line, append-only.
    /// queue.cursor  "&lt;fileId&gt; &lt;n&gt;": the first n event lines are already acked/dropped.
    ///
    /// Acking only moves the cursor (a tiny write). The file is rewritten (compacted) only when
    /// most of it is dead, and the new file gets a new id so a stale cursor can never be applied
    /// to it. If the app dies anywhere in this sequence, the worst case is that events are sent
    /// again, which the server de-duplicates by event_id.
    /// </summary>
    internal sealed class AvnEventQueue
    {
        const int CompactMinDeadLines = 200;
        const long QuarantineMaxBytes = 256 * 1024;

        readonly object gate = new object();
        readonly string queuePath, cursorPath, quarantinePath;
        readonly int maxEvents;
        readonly long maxBytes;
        readonly List<string> lines = new List<string>(); // pending (un-acked) events
        readonly Action<string> log;

        long bytes;
        string fileId;   // null = no file on disk
        int cursor;      // dead lines at the start of the file
        FileStream stream;

        internal AvnEventQueue(string directory, int maxEvents, long maxBytes, Action<string> log)
        {
            this.maxEvents = maxEvents;
            this.maxBytes = maxBytes;
            this.log = log ?? (_ => { });
            Directory.CreateDirectory(directory);
            queuePath = Path.Combine(directory, "queue.jsonl");
            cursorPath = Path.Combine(directory, "queue.cursor");
            quarantinePath = Path.Combine(directory, "quarantine.jsonl");
            Load();
        }

        internal int Count { get { lock (gate) return lines.Count; } }

        void Load()
        {
            lock (gate)
            {
                string tmp = queuePath + ".tmp";
                try
                {
                    if (File.Exists(tmp))
                    {
                        // tmp next to a live queue = an interrupted compaction; the live file is complete.
                        if (File.Exists(queuePath)) File.Delete(tmp);
                        else File.Move(tmp, queuePath);
                    }
                }
                catch (Exception e) { log("Queue tmp recovery failed: " + e.Message); }

                if (!File.Exists(queuePath)) { DeleteQuietly(cursorPath); return; }

                bool dirty = false;
                try
                {
                    byte[] raw = File.ReadAllBytes(queuePath);
                    if (raw.Length > 0 && raw[raw.Length - 1] != (byte)'\n') dirty = true; // torn last write
                    string[] all = Encoding.UTF8.GetString(raw).Split('\n');
                    int count = all.Length;
                    if (count > 0 && all[count - 1].Length == 0) count--; // text after the final '\n'

                    int start = 0;
                    if (count > 0 && all[0].StartsWith("#", StringComparison.Ordinal))
                    {
                        fileId = all[0].Substring(1).Trim();
                        start = 1;
                    }
                    else dirty = true; // missing header

                    int dead = ReadCursor(fileId);
                    for (int i = start; i < count; i++)
                    {
                        if (i - start < dead) continue;
                        string line = all[i].TrimEnd('\r');
                        if (IsEventLine(line)) { lines.Add(line); bytes += Encoding.UTF8.GetByteCount(line); }
                        else dirty = true; // torn/corrupt line: drop
                    }
                    if (dead > 0) dirty = true;
                }
                catch (Exception e)
                {
                    log("Queue load failed, starting empty: " + e.Message);
                    lines.Clear(); bytes = 0; fileId = null;
                    DeleteQuietly(queuePath); DeleteQuietly(cursorPath);
                    return;
                }

                // Normalize on-disk state: physical lines == pending lines, fresh id, cursor 0.
                if (dirty) Compact();
                else cursor = 0;
                if (lines.Count > maxEvents || bytes > maxBytes) EnforceCap();
            }
        }

        int ReadCursor(string id)
        {
            try
            {
                if (id == null || !File.Exists(cursorPath)) return 0;
                string[] parts = File.ReadAllText(cursorPath).Trim().Split(' ');
                if (parts.Length == 2 && parts[0] == id && int.TryParse(parts[1], out int n) && n > 0) return n;
            }
            catch (Exception) { }
            return 0; // unreadable cursor: resend, the server dedups
        }

        // A line is "<context json>\t<event json>", or a bare event json (queues written by older SDK versions).
        static bool IsEventLine(string s)
        {
            if (s.Length <= 2 || s[0] != '{' || s[s.Length - 1] != '}') return false;
            int tab = s.IndexOf('\t');
            return tab < 0 || (tab > 0 && s[tab - 1] == '}' && tab + 1 < s.Length && s[tab + 1] == '{');
        }

        static string ContextOf(string line)
        {
            int tab = line.IndexOf('\t');
            return tab < 0 ? "" : line.Substring(0, tab);
        }

        static bool SameContext(string line, string context)
        {
            if (context.Length == 0) return line.IndexOf('\t') < 0;
            return line.Length > context.Length && line[context.Length] == '\t'
                && string.CompareOrdinal(line, 0, context, 0, context.Length) == 0;
        }

        /// <summary>Persist the event to disk, then add it to the pending list.</summary>
        internal bool Append(string line)
        {
            lock (gate)
            {
                try
                {
                    if (stream == null) OpenForAppend();
                    byte[] data = Encoding.UTF8.GetBytes(line + "\n");
                    stream.Write(data, 0, data.Length);
                    stream.Flush(false); // hand to the OS now; fsync happens on SyncToDisk
                }
                catch (Exception e)
                {
                    log("Could not persist event (dropped): " + e.Message);
                    CloseStream();
                    return false;
                }
                lines.Add(line);
                bytes += Encoding.UTF8.GetByteCount(line);
                if (lines.Count > maxEvents || bytes > maxBytes) EnforceCap();
                return true;
            }
        }

        void OpenForAppend()
        {
            if (fileId == null || !File.Exists(queuePath))
            {
                fileId = Guid.NewGuid().ToString("N");
                File.WriteAllText(queuePath, "#" + fileId + "\n", new UTF8Encoding(false));
                cursor = 0;
                DeleteQuietly(cursorPath);
            }
            stream = new FileStream(queuePath, FileMode.Append, FileAccess.Write, FileShare.Read);
        }

        void EnforceCap()
        {
            // Drop the oldest ~10% (at least one) so we are not trimming on every append.
            int drop = Math.Max(1, Math.Max(lines.Count - maxEvents, lines.Count / 10));
            while (drop < lines.Count && bytes - BytesOfHead(drop) > maxBytes) drop += Math.Max(1, lines.Count / 20);
            drop = Math.Min(drop, lines.Count);
            log("Queue full: dropping " + drop + " oldest events");
            AdvanceLocked(drop);
        }

        long BytesOfHead(int n)
        {
            long b = 0;
            for (int i = 0; i < n && i < lines.Count; i++) b += Encoding.UTF8.GetByteCount(lines[i]);
            return b;
        }

        /// <summary>
        /// Returns a ready-to-send body for the oldest events, or null if empty:
        /// {"context":{...},"events":[...]} when the events share a context (the batch stops at the
        /// first event whose context differs), or plain {"events":[...]} for legacy lines.
        /// </summary>
        internal string PeekBatch(int maxCount, int maxBodyBytes, out int count)
        {
            lock (gate)
            {
                count = 0;
                if (lines.Count == 0) return null;
                string context = ContextOf(lines[0]);
                var sb = new StringBuilder(context.Length > 0 ? "{\"context\":" + context + ",\"events\":[" : "{\"events\":[");
                long size = sb.Length + 2;
                for (int i = 0; i < lines.Count && i < maxCount; i++)
                {
                    string line = lines[i];
                    if (i > 0 && !SameContext(line, context)) break;
                    string ev = context.Length > 0 ? line.Substring(context.Length + 1) : line;
                    long add = Encoding.UTF8.GetByteCount(ev) + 1;
                    if (i > 0 && size + add > maxBodyBytes) break;
                    if (i > 0) sb.Append(',');
                    sb.Append(ev);
                    size += add;
                    count++;
                }
                sb.Append("]}");
                return sb.ToString();
            }
        }

        /// <summary>Remove the oldest n events: the server acked them.</summary>
        internal void Advance(int n) { lock (gate) AdvanceLocked(n); }

        /// <summary>Move the oldest n events to the quarantine file (server rejected them as invalid).</summary>
        internal void Quarantine(int n)
        {
            lock (gate)
            {
                try
                {
                    if (File.Exists(quarantinePath) && new FileInfo(quarantinePath).Length > QuarantineMaxBytes)
                        File.Delete(quarantinePath);
                    var sb = new StringBuilder();
                    for (int i = 0; i < n && i < lines.Count; i++) sb.Append(lines[i]).Append('\n');
                    File.AppendAllText(quarantinePath, sb.ToString(), new UTF8Encoding(false));
                }
                catch (Exception e) { log("Quarantine write failed: " + e.Message); }
                AdvanceLocked(n);
            }
        }

        void AdvanceLocked(int n)
        {
            n = Math.Min(n, lines.Count);
            if (n <= 0) return;
            bytes -= BytesOfHead(n);
            lines.RemoveRange(0, n);
            cursor += n;
            try
            {
                if (lines.Count == 0)
                {
                    CloseStream();
                    DeleteQuietly(queuePath);
                    DeleteQuietly(cursorPath);
                    fileId = null; cursor = 0; bytes = 0;
                }
                else if (cursor >= CompactMinDeadLines && cursor >= lines.Count) Compact();
                else File.WriteAllText(cursorPath, fileId + " " + cursor);
            }
            catch (Exception e) { log("Queue bookkeeping failed (events may be re-sent): " + e.Message); }
        }

        /// <summary>Rewrite the file with only pending lines under a new id.</summary>
        void Compact()
        {
            CloseStream();
            if (lines.Count == 0)
            {
                DeleteQuietly(queuePath); DeleteQuietly(cursorPath);
                fileId = null; cursor = 0;
                return;
            }
            string newId = Guid.NewGuid().ToString("N");
            var sb = new StringBuilder("#" + newId + "\n");
            foreach (string l in lines) sb.Append(l).Append('\n');
            AvnFiles.AtomicWrite(queuePath, sb.ToString());
            DeleteQuietly(cursorPath);
            fileId = newId;
            cursor = 0;
        }

        /// <summary>fsync the queue file (call when the app is pausing or quitting).</summary>
        internal void SyncToDisk()
        {
            lock (gate)
            {
                try { stream?.Flush(true); }
                catch (Exception e) { log("fsync failed: " + e.Message); }
            }
        }

        internal void Close() { lock (gate) { SyncToDiskLocked(); CloseStream(); } }

        void SyncToDiskLocked() { try { stream?.Flush(true); } catch (Exception) { } }

        void CloseStream()
        {
            try { stream?.Dispose(); } catch (Exception) { }
            stream = null;
        }

        static void DeleteQuietly(string path)
        {
            try { if (File.Exists(path)) File.Delete(path); } catch (Exception) { }
        }
    }
}

// CaptureDesk native messaging host — C# / .NET 8 (capturedesk-native-host).
//
// A drop-in replacement for the Node.js host on the v2 native stack: it
// receives recording bytes from the CaptureDesk Chrome extension over
// native messaging and writes them straight to the local CaptureDesk
// Recordings folder, skipping the browser Downloads pipeline.
//
// Wire protocol (identical to the Node host; each JSON body is length-
// prefixed with a 32-bit little-endian integer, per Chrome native messaging):
//   → { "type": "ping" }                       → { "type": "pong", ... }
//   → { "type": "begin", "fileName", "size" }  → { "type": "begin-ok", "path" }
//   → { "type": "chunk", "data": <base64> }    → { "type": "chunk-ok", "written" }
//   → { "type": "end" }                        → { "type": "end-ok", "path", "size" }
//   → { "type": "abort" }                      → { "type": "abort-ok" }

using System.Text;
using System.Text.Json;

namespace CaptureDesk.NativeHost;

internal static class Program
{
    private static readonly byte[] Header = new byte[4];

    private static void Main()
    {
        using Stream stdin = Console.OpenStandardInput();
        using Stream stdout = Console.OpenStandardOutput();

        var state = new TransferState();
        var header = new byte[4];

        while (ReadExact(stdin, header, 4))
        {
            uint length = BitConverter.ToUInt32(header, 0);
            if (length <= 0 || length > 64 * 1024 * 1024)
            {
                Send(stdout, new { type = "error", error = "Invalid frame length." });
                return;
            }

            var body = new byte[length];
            if (!ReadExact(stdin, body, (int)length))
            {
                break;
            }

            try
            {
                using var doc = JsonDocument.Parse(body);
                Handle(doc.RootElement, state, stdout);
            }
            catch (JsonException ex)
            {
                Send(stdout, new { type = "error", error = ex.Message });
            }
        }

        // stdin closed: finalize any in-flight transfer so partial data
        // survives, then exit.
        state.FinishPending();
    }

    private static void Handle(JsonElement msg, TransferState state, Stream stdout)
    {
        if (msg.ValueKind != JsonValueKind.Object ||
            !msg.TryGetProperty("type", out JsonElement typeEl) ||
            typeEl.ValueKind != JsonValueKind.String)
        {
            Send(stdout, new { type = "error", error = "Malformed message." });
            return;
        }

        switch (typeEl.GetString())
        {
            case "ping":
                Send(stdout, new
                {
                    type = "pong",
                    host = "capturedesk-native-host",
                    version = "2.0.0",
                    dir = TransferState.PreferredDir,
                });
                break;

            case "begin":
                string fileName = msg.TryGetProperty("fileName", out JsonElement fn)
                    ? fn.GetString() ?? string.Empty
                    : string.Empty;
                string? error = state.Begin(fileName, out string target);
                if (error == null)
                {
                    Send(stdout, new { type = "begin-ok", path = target });
                }
                else
                {
                    Send(stdout, new { type = "error", error });
                }
                break;

            case "chunk":
                if (!state.Active)
                {
                    Send(stdout, new { type = "error", error = "No active transfer. Send \"begin\" first." });
                    return;
                }
                string data = msg.TryGetProperty("data", out JsonElement d)
                    ? d.GetString() ?? string.Empty
                    : string.Empty;
                long written = state.WriteChunk(data);
                Send(stdout, new { type = "chunk-ok", written });
                break;

            case "end":
                if (!state.Active)
                {
                    Send(stdout, new { type = "error", error = "No active transfer." });
                    return;
                }
                (string path, long size) = state.Finish();
                Send(stdout, new { type = "end-ok", path, size });
                break;

            case "abort":
                state.Abort();
                Send(stdout, new { type = "abort-ok" });
                break;

            default:
                Send(stdout, new { type = "error", error = $"Unknown type: {typeEl.GetString()}" });
                break;
        }
    }

    private static void Send(Stream stdout, object message)
    {
        var body = JsonSerializer.SerializeToUtf8Bytes(message);
        BitConverter.GetBytes((uint)body.Length).CopyTo(Header, 0);
        stdout.Write(Header, 0, 4);
        stdout.Write(body, 0, body.Length);
        stdout.Flush();
    }

    private static bool ReadExact(Stream stream, byte[] buffer, int count)
    {
        int read = 0;
        while (read < count)
        {
            int n = stream.Read(buffer, read, count - read);
            if (n <= 0)
            {
                return false;
            }
            read += n;
        }
        return true;
    }
}

/// One begin → chunk* → end transfer into the CaptureDesk Recordings folder.
internal sealed class TransferState
{
    public static string PreferredDir { get; } = ResolveDir();

    private FileStream? _stream;
    private string _fileName = string.Empty;
    private string _dir = string.Empty;
    private long _written;

    public bool Active => _stream != null;

    public string? Begin(string rawName, out string target)
    {
        _stream?.Dispose();
        _stream = null;

        _dir = PreferredDir;
        _fileName = SafeName(rawName);
        target = Path.Combine(_dir, _fileName);
        try
        {
            _stream = new FileStream(target, FileMode.Create, FileAccess.Write, FileShare.None);
            _written = 0;
            return null;
        }
        catch (Exception ex)
        {
            _stream = null;
            return ex.Message;
        }
    }

    public long WriteChunk(string base64)
    {
        byte[] bytes = Convert.FromBase64String(string.IsNullOrWhiteSpace(base64) ? string.Empty : base64);
        _stream?.Write(bytes, 0, bytes.Length);
        _written += bytes.Length;
        return _written;
    }

    public (string path, long size) Finish()
    {
        _stream?.Flush();
        _stream?.Dispose();
        _stream = null;
        return (Path.Combine(_dir, _fileName), _written);
    }

    public void Abort()
    {
        if (_stream != null)
        {
            string partial = Path.Combine(_dir, _fileName);
            _stream.Dispose();
            _stream = null;
            try { File.Delete(partial); } catch (IOException) { /* best effort */ }
        }
    }

    /// Finalize a transfer that was still open when stdin closed.
    public void FinishPending()
    {
        if (_stream != null)
        {
            _stream.Flush();
            _stream.Dispose();
            _stream = null;
        }
    }

    private static string ResolveDir()
    {
        string env = Environment.GetEnvironmentVariable("CAPTUREDESK_HOME") ?? string.Empty;
        string profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        string[] candidates =
        {
            string.IsNullOrWhiteSpace(env) ? Path.Combine(profile, "Videos", "CaptureDesk") : env,
            Path.Combine(profile, "CaptureDesk"),
        };
        foreach (string dir in candidates)
        {
            try
            {
                Directory.CreateDirectory(dir);
                var probe = Path.Combine(dir, ".capturedesk-probe");
                File.WriteAllText(probe, "ok");
                File.Delete(probe);
                return dir;
            }
            catch (UnauthorizedAccessException) { }
            catch (IOException) { }
        }
        return Path.GetTempPath();
    }

    private static string SafeName(string name)
    {
        var sb = new StringBuilder(name ?? string.Empty);
        foreach (char c in Path.GetInvalidFileNameChars())
        {
            sb.Replace(c, '-');
        }
        string clean = sb.ToString().Trim().TrimStart('.');
        if (string.IsNullOrWhiteSpace(clean) || clean == "-")
        {
            clean = $"CaptureDesk_{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}.webm";
        }
        return clean;
    }
}

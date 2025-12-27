using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

internal class Program
{
    private static async Task Main(string[] args)
    {
        Console.WriteLine("BlueMarble 像素取色（Tampermonkey -> 本地HTTP）");
        Console.WriteLine("说明：页面脚本将鼠标坐标POST到本地端口，本程序读取并计算模板像素颜色。");
        Console.WriteLine();

        var settings = ReadSettings(args);
        if (string.IsNullOrWhiteSpace(settings.TemplatePath) || !File.Exists(settings.TemplatePath))
        {
            Console.WriteLine("未找到模板图片，请检查路径。");
            return;
        }

        var origin = ReadOrigin(settings.Origin);
        if (origin == null)
        {
            Console.WriteLine("基准坐标格式错误，应为: tileX,tileY,pxX,pyY");
            return;
        }

        using var template = TemplateImage.Load(settings.TemplatePath);
        Console.WriteLine($"模板尺寸: {template.Width} x {template.Height}");
        Console.WriteLine($"基准坐标: {origin.Value.TileX},{origin.Value.TileY},{origin.Value.PxX},{origin.Value.PyY}");
        Console.WriteLine($"监听地址: http://localhost:{settings.Port}/coords");
        Console.WriteLine($"轮询间隔: {settings.PollMs} ms");
        Console.WriteLine("请先启用 Tampermonkey 脚本并打开 wplace 页面。");
        Console.WriteLine();

        using var cts = new CancellationTokenSource();
        Console.CancelKeyPress += (_, e) =>
        {
            e.Cancel = true;
            cts.Cancel();
        };

        var state = new SharedState();
        using var listener = StartListener(settings.Port, state, cts.Token);

        var last = new LastSample();
        var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(settings.PollMs));
        try
        {
            while (await timer.WaitForNextTickAsync(cts.Token))
            {
                var tp = state.GetLatest();
                if (tp == null)
                {
                    if (!last.WaitingForData)
                    {
                        last.WaitingForData = true;
                        Console.WriteLine("等待浏览器坐标数据...");
                    }
                    continue;
                }

                last.WaitingForData = false;
                if (!tp.Ok)
                {
                    if (tp.Reason != last.LastReason)
                    {
                        last.LastReason = tp.Reason;
                        Console.WriteLine($"无法获取坐标: {tp.Reason}");
                        if (tp.Reason == "canvas_not_found")
                        {
                            Console.WriteLine("提示: 检查页面上是否存在 maplibre canvas，例如 #map canvas.maplibregl-canvas");
                        }
                        else if (tp.Reason == "map_not_found")
                        {
                            Console.WriteLine("提示: 在控制台确认地图对象名称，并在脚本中配置 window.__bmPickerMap 或 map 名称列表。");
                        }
                    }
                    continue;
                }

                var rel = ComputeRelative(origin.Value, tp);
                if (rel.RelX < 0 || rel.RelY < 0 || rel.RelX >= template.Width || rel.RelY >= template.Height)
                {
                    if (last.LastOutOfBounds != true || last.CellX != tp.CellX || last.CellY != tp.CellY)
                    {
                        last.LastOutOfBounds = true;
                        last.CellX = tp.CellX;
                        last.CellY = tp.CellY;
                        Console.WriteLine($"鼠标像素({tp.CellX},{tp.CellY})超出模板范围 (模板坐标: {rel.RelX},{rel.RelY})");
                    }
                    continue;
                }

                var color = template.GetPixel(rel.RelX, rel.RelY);
                if (!last.Same(rel, color))
                {
                    last.Update(rel, color);
                    Console.WriteLine($"像素({tp.CellX},{tp.CellY}) 模板({rel.RelX},{rel.RelY}) RGB({color.R},{color.G},{color.B})");
                }
            }
        }
        catch (OperationCanceledException)
        {
            Console.WriteLine("已退出。");
        }
    }

    private static PickerSettings ReadSettings(string[] args)
    {
        var settings = new PickerSettings();
        for (var i = 0; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "--template":
                    settings.TemplatePath = GetArgValue(args, ref i);
                    break;
                case "--origin":
                    settings.Origin = GetArgValue(args, ref i);
                    break;
                case "--port":
                    if (int.TryParse(GetArgValue(args, ref i), out var port))
                    {
                        settings.Port = Math.Clamp(port, 1024, 65535);
                    }
                    break;
                case "--poll-ms":
                    if (int.TryParse(GetArgValue(args, ref i), out var ms))
                    {
                        settings.PollMs = Math.Max(50, ms);
                    }
                    break;
            }
        }

        if (string.IsNullOrWhiteSpace(settings.TemplatePath))
        {
            Console.Write("模板路径(本地PNG): ");
            settings.TemplatePath = Console.ReadLine() ?? "";
        }

        if (string.IsNullOrWhiteSpace(settings.Origin))
        {
            Console.Write("基准坐标(tileX,tileY,pxX,pyY): ");
            settings.Origin = Console.ReadLine() ?? "";
        }

        return settings;
    }

    private static string GetArgValue(string[] args, ref int i)
    {
        if (i + 1 < args.Length)
        {
            i++;
            return args[i];
        }
        return "";
    }

    private static Origin? ReadOrigin(string input)
    {
        var parts = input.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (parts.Length != 4)
        {
            return null;
        }

        if (!int.TryParse(parts[0], NumberStyles.Integer, CultureInfo.InvariantCulture, out var tileX)) return null;
        if (!int.TryParse(parts[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out var tileY)) return null;
        if (!int.TryParse(parts[2], NumberStyles.Integer, CultureInfo.InvariantCulture, out var pxX)) return null;
        if (!int.TryParse(parts[3], NumberStyles.Integer, CultureInfo.InvariantCulture, out var pyY)) return null;

        return new Origin(tileX, tileY, pxX, pyY);
    }

    private static HttpListener StartListener(int port, SharedState state, CancellationToken token)
    {
        var listener = new HttpListener();
        listener.Prefixes.Add($"http://localhost:{port}/");
        listener.Start();

        _ = Task.Run(async () =>
        {
            while (!token.IsCancellationRequested)
            {
                HttpListenerContext? ctx = null;
                try
                {
                    ctx = await listener.GetContextAsync();
                }
                catch (HttpListenerException)
                {
                    break;
                }
                catch (ObjectDisposedException)
                {
                    break;
                }

                if (ctx == null) { continue; }

                _ = Task.Run(async () =>
                {
                    await HandleRequestAsync(ctx, state);
                }, token);
            }
        }, token);

        return listener;
    }

    private static async Task HandleRequestAsync(HttpListenerContext ctx, SharedState state)
    {
        try
        {
            if (ctx.Request.HttpMethod.Equals("POST", StringComparison.OrdinalIgnoreCase) &&
                ctx.Request.Url?.AbsolutePath == "/coords")
            {
                using var reader = new StreamReader(ctx.Request.InputStream, ctx.Request.ContentEncoding);
                var body = await reader.ReadToEndAsync();
                var tp = JsonSerializer.Deserialize<TilePixel>(body, JsonOpts());
                if (tp != null)
                {
                    state.SetLatest(tp);
                }

                var buffer = Encoding.UTF8.GetBytes("ok");
                ctx.Response.StatusCode = 200;
                ctx.Response.ContentType = "text/plain; charset=utf-8";
                await ctx.Response.OutputStream.WriteAsync(buffer);
                ctx.Response.Close();
                return;
            }

            ctx.Response.StatusCode = 404;
            ctx.Response.Close();
        }
        catch
        {
            try { ctx.Response.StatusCode = 500; ctx.Response.Close(); } catch { }
        }
    }

    private static JsonSerializerOptions JsonOpts() => new()
    {
        PropertyNameCaseInsensitive = true
    };

    private static Relative ComputeRelative(Origin origin, TilePixel tp)
    {
        var globalX = (tp.TileX * 1000) + tp.PxX;
        var globalY = (tp.TileY * 1000) + tp.PyY;
        var originX = (origin.TileX * 1000) + origin.PxX;
        var originY = (origin.TileY * 1000) + origin.PyY;
        return new Relative(globalX - originX, globalY - originY);
    }

    private sealed class PickerSettings
    {
        public string TemplatePath { get; set; } = "";
        public string Origin { get; set; } = "";
        public int Port { get; set; } = 8787;
        public int PollMs { get; set; } = 100;
    }

    private readonly record struct Origin(int TileX, int TileY, int PxX, int PyY);
    private readonly record struct Relative(int RelX, int RelY);

    private sealed class TilePixel
    {
        public bool Ok { get; set; }
        public string Reason { get; set; } = "";
        public int TileX { get; set; }
        public int TileY { get; set; }
        public int PxX { get; set; }
        public int PyY { get; set; }
        public int TileSize { get; set; }
        public int CellX { get; set; }
        public int CellY { get; set; }
    }

    private sealed class SharedState
    {
        private readonly object _lock = new();
        private TilePixel? _latest;
        private DateTime _lastSeen = DateTime.MinValue;

        public void SetLatest(TilePixel tp)
        {
            lock (_lock)
            {
                _latest = tp;
                _lastSeen = DateTime.UtcNow;
            }
        }

        public TilePixel? GetLatest()
        {
            lock (_lock)
            {
                if (_latest == null) { return null; }
                if ((DateTime.UtcNow - _lastSeen) > TimeSpan.FromSeconds(3))
                {
                    return null;
                }
                return _latest;
            }
        }
    }

    private sealed class LastSample
    {
        public int RelX { get; private set; } = int.MinValue;
        public int RelY { get; private set; } = int.MinValue;
        public int CellX { get; set; } = int.MinValue;
        public int CellY { get; set; } = int.MinValue;
        public Color Color { get; private set; } = Color.Empty;
        public string LastReason { get; set; } = "";
        public bool LastOutOfBounds { get; set; }
        public bool WaitingForData { get; set; }

        public bool Same(Relative rel, Color color)
        {
            return rel.RelX == RelX && rel.RelY == RelY && color.ToArgb() == Color.ToArgb();
        }

        public void Update(Relative rel, Color color)
        {
            RelX = rel.RelX;
            RelY = rel.RelY;
            Color = color;
            LastOutOfBounds = false;
        }
    }

    private sealed class TemplateImage : IDisposable
    {
        private readonly Bitmap _bitmap;
        private readonly byte[] _data;
        private readonly int _stride;

        public int Width { get; }
        public int Height { get; }

        private TemplateImage(Bitmap bitmap, byte[] data, int stride)
        {
            _bitmap = bitmap;
            _data = data;
            _stride = stride;
            Width = bitmap.Width;
            Height = bitmap.Height;
        }

        public static TemplateImage Load(string path)
        {
            var bmp = new Bitmap(path);
            var rect = new Rectangle(0, 0, bmp.Width, bmp.Height);
            var data = bmp.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
            var bytes = new byte[Math.Abs(data.Stride) * data.Height];
            Marshal.Copy(data.Scan0, bytes, 0, bytes.Length);
            bmp.UnlockBits(data);
            return new TemplateImage(bmp, bytes, data.Stride);
        }

        public Color GetPixel(int x, int y)
        {
            if (x < 0 || y < 0 || x >= Width || y >= Height)
            {
                return Color.Empty;
            }

            var idx = (y * _stride) + (x * 4);
            var b = _data[idx];
            var g = _data[idx + 1];
            var r = _data[idx + 2];
            var a = _data[idx + 3];
            return Color.FromArgb(a, r, g, b);
        }

        public void Dispose()
        {
            _bitmap.Dispose();
        }
    }
}

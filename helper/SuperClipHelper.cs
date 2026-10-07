// SuperClipHelper - Trợ giúp Win32 native cho SuperClipboard
// Chức năng:
//   1. Lắng nghe sự kiện clipboard (WM_CLIPBOARDUPDATE) và trích xuất nội dung (text/html/ảnh/files)
//   2. Đọc "SourceURL" từ định dạng CF_HTML -> biết chính xác trang web nguồn
//   3. Theo dõi cửa sổ đang focus (app nguồn / app đích)
//   4. Bắt sự kiện Ctrl+V ở tầng hệ điều hành -> biết chính xác đã dán vào app nào
//   5. Nhận lệnh từ stdin: paste, focus, hotkey, ping, quit
//
// Giao thức: mỗi dòng stdout là một đối tượng JSON.
// Biên dịch bằng csc.exe của .NET Framework 3.5/4.x.

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Collections.Specialized;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

internal static class Native
{
    public delegate void WinEventDelegate(IntPtr hWinEventHook, uint eventType, IntPtr hwnd,
        int idObject, int idChild, uint dwEventThread, uint dwmsEventTime);

    public delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    public struct KBDLLHOOKSTRUCT
    {
        public uint vkCode;
        public uint scanCode;
        public uint flags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool AddClipboardFormatListener(IntPtr hwnd);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool RemoveClipboardFormatListener(IntPtr hwnd);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("kernel32.dll")]
    public static extern uint GetCurrentThreadId();

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool BringWindowToTop(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool UnregisterHotKey(IntPtr hWnd, int id);

    [DllImport("user32.dll")]
    public static extern uint GetClipboardSequenceNumber();

    [DllImport("user32.dll")]
    public static extern short GetAsyncKeyState(int vKey);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc lpfn, IntPtr hMod, uint dwThreadId);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool UnhookWindowsHookEx(IntPtr hhk);

    [DllImport("user32.dll")]
    public static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr GetModuleHandleW(string lpModuleName);

    [DllImport("user32.dll")]
    public static extern IntPtr SetWinEventHook(uint eventMin, uint eventMax, IntPtr hmodWinEventProc,
        WinEventDelegate lpfnWinEventProc, uint idProcess, uint idThread, uint dwFlags);

    [DllImport("user32.dll")]
    public static extern bool UnhookWinEvent(IntPtr hWinEventHook);

    [DllImport("user32.dll")]
    public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

    public const int WH_KEYBOARD_LL = 13;
    public const int WM_KEYDOWN = 0x0100;
    public const int WM_SYSKEYDOWN = 0x0104;
    public const uint EVENT_SYSTEM_FOREGROUND = 0x0003;
    public const uint WINEVENT_OUTOFCONTEXT = 0x0000;
    public const uint WINEVENT_SKIPOWNPROCESS = 0x0002;
    public const byte VK_CONTROL = 0x11;
    public const byte VK_SHIFT = 0x10;
    public const byte VK_MENU = 0x12;
    public const byte VK_V = 0x56;
    public const byte VK_INSERT = 0x2D;
    public const uint KEYEVENTF_KEYUP = 0x0002;
}

/// <summary>
/// Bộ đọc JSON tối giản nhưng CHÍNH XÁC cho các lệnh gửi từ Node sang.
/// Cần thiết vì nội dung clipboard là văn bản tuỳ ý (có thể chứa dấu ngoặc, \\uXXXX,
/// đường dẫn Windows...), không thể tách bằng biểu thức chính quy.
/// </summary>
internal static class Json
{
    public static Dictionary<string, object> ParseObject(string s)
    {
        int i = 0;
        return (Dictionary<string, object>)ParseValue(s, ref i);
    }

    private static object ParseValue(string s, ref int i)
    {
        SkipWs(s, ref i);
        if (i >= s.Length) return null;
        char c = s[i];
        if (c == '{') return ParseObj(s, ref i);
        if (c == '[') return ParseArr(s, ref i);
        if (c == '"') return ParseStr(s, ref i);
        if (c == 't') { i += 4; return true; }
        if (c == 'f') { i += 5; return false; }
        if (c == 'n') { i += 4; return null; }
        return ParseNum(s, ref i);
    }

    private static Dictionary<string, object> ParseObj(string s, ref int i)
    {
        Dictionary<string, object> d = new Dictionary<string, object>(StringComparer.OrdinalIgnoreCase);
        i++;                                  // '{'
        SkipWs(s, ref i);
        if (i < s.Length && s[i] == '}') { i++; return d; }
        while (i < s.Length)
        {
            SkipWs(s, ref i);
            if (i >= s.Length || s[i] != '"') break;
            string k = ParseStr(s, ref i);
            SkipWs(s, ref i);
            if (i < s.Length && s[i] == ':') i++;
            object v = ParseValue(s, ref i);
            d[k] = v;
            SkipWs(s, ref i);
            if (i < s.Length && s[i] == ',') { i++; continue; }
            if (i < s.Length && s[i] == '}') { i++; break; }
            break;
        }
        return d;
    }

    private static List<object> ParseArr(string s, ref int i)
    {
        List<object> a = new List<object>();
        i++;                                  // '['
        SkipWs(s, ref i);
        if (i < s.Length && s[i] == ']') { i++; return a; }
        while (i < s.Length)
        {
            object v = ParseValue(s, ref i);
            a.Add(v);
            SkipWs(s, ref i);
            if (i < s.Length && s[i] == ',') { i++; continue; }
            if (i < s.Length && s[i] == ']') { i++; break; }
            break;
        }
        return a;
    }

    private static string ParseStr(string s, ref int i)
    {
        StringBuilder sb = new StringBuilder();
        i++;                                  // dấu " mở đầu
        while (i < s.Length)
        {
            char c = s[i++];
            if (c == '"') break;
            if (c != '\\') { sb.Append(c); continue; }
            if (i >= s.Length) break;
            char e = s[i++];
            switch (e)
            {
                case '"': sb.Append('"'); break;
                case '\\': sb.Append('\\'); break;
                case '/': sb.Append('/'); break;
                case 'b': sb.Append('\b'); break;
                case 'f': sb.Append('\f'); break;
                case 'n': sb.Append('\n'); break;
                case 'r': sb.Append('\r'); break;
                case 't': sb.Append('\t'); break;
                case 'u':
                    if (i + 4 <= s.Length)
                    {
                        int cp;
                        if (int.TryParse(s.Substring(i, 4), System.Globalization.NumberStyles.HexNumber,
                                System.Globalization.CultureInfo.InvariantCulture, out cp))
                        {
                            sb.Append((char)cp);
                            i += 4;
                        }
                    }
                    break;
                default: sb.Append(e); break;
            }
        }
        return sb.ToString();
    }

    private static double ParseNum(string s, ref int i)
    {
        int start = i;
        while (i < s.Length && (char.IsDigit(s[i]) || s[i] == '-' || s[i] == '+' || s[i] == '.' ||
               s[i] == 'e' || s[i] == 'E')) i++;
        double d;
        double.TryParse(s.Substring(start, i - start), System.Globalization.NumberStyles.Float,
            System.Globalization.CultureInfo.InvariantCulture, out d);
        return d;
    }

    private static void SkipWs(string s, ref int i)
    {
        while (i < s.Length && (s[i] == ' ' || s[i] == '\t' || s[i] == '\r' || s[i] == '\n')) i++;
    }

    // ---- Truy cập có kiểu ----

    public static string Str(Dictionary<string, object> d, string key)
    {
        object o;
        if (d == null || !d.TryGetValue(key, out o) || o == null) return null;
        return o as string;
    }

    public static long Num(Dictionary<string, object> d, string key, long fallback)
    {
        object o;
        if (d == null || !d.TryGetValue(key, out o) || o == null) return fallback;
        if (o is double) return (long)(double)o;
        if (o is bool) return ((bool)o) ? 1 : 0;
        long v;
        if (o is string && long.TryParse((string)o, out v)) return v;
        return fallback;
    }

    public static List<string> StrList(Dictionary<string, object> d, string key)
    {
        List<string> outList = new List<string>();
        object o;
        if (d == null || !d.TryGetValue(key, out o) || o == null) return outList;
        List<object> arr = o as List<object>;
        if (arr == null) return outList;
        foreach (object x in arr) if (x is string) outList.Add((string)x);
        return outList;
    }
}

internal sealed class HiddenWindow : Form
{
    public const int WM_CLIPBOARDUPDATE = 0x031D;
    public const int WM_HOTKEY = 0x0312;

    public HiddenWindow()
    {
        this.ShowInTaskbar = false;
        this.FormBorderStyle = FormBorderStyle.None;
        this.StartPosition = FormStartPosition.Manual;
        this.Location = new Point(-4000, -4000);
        this.Size = new Size(1, 1);
        this.ShowInTaskbar = false;
        this.Opacity = 0.0;
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        Native.AddClipboardFormatListener(this.Handle);
    }

    protected override void OnHandleDestroyed(EventArgs e)
    {
        try { Native.RemoveClipboardFormatListener(this.Handle); }
        catch { }
        base.OnHandleDestroyed(e);
    }

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == WM_CLIPBOARDUPDATE)
        {
            try { Program.OnClipboardUpdate(); }
            catch (Exception ex) { Program.EmitError("clipboard", ex); }
        }
        else if (m.Msg == WM_HOTKEY)
        {
            Program.OnHotkey(m.WParam.ToInt32());
        }
        base.WndProc(ref m);
    }
}

internal static class Program
{
    private static readonly ConcurrentQueue<string> OutQueue = new ConcurrentQueue<string>();
    private static HiddenWindow _win;
    private static IntPtr _kbHook = IntPtr.Zero;
    private static IntPtr _winEventHook = IntPtr.Zero;
    private static Native.WinEventDelegate _winEventProc;     // giữ tham chiếu tránh GC
    private static Native.LowLevelKeyboardProc _kbProc;       // giữ tham chiếu tránh GC
    private static long _lastFocusEmit;
    private static string _lastFocusKey = "";
    private static volatile bool _injecting;
    private static string _tmpDir;
    private static uint _lastSeq;
    private static uint _lastEmittedSeq;
    private static string _lastFingerprint = "";
    private static long _lastEmitTime;
    private static bool _noKbHook;
    private static long _suppressUntil;
    private static System.Windows.Forms.Timer _debounce;
    private static readonly object ClipLock = new object();

    [STAThread]
    private static void Main(string[] args)
    {
        _tmpDir = Path.Combine(Path.GetTempPath(), "SuperClipboard", "tmp");
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--tmp" && i + 1 < args.Length) _tmpDir = args[i + 1];
            else if (args[i] == "--no-kbhook") _noKbHook = true;
        }
        try { Directory.CreateDirectory(_tmpDir); }
        catch { }

        // Cửa sổ ẩn phải được tạo TRƯỚC luồng đọc stdin, vì mọi lệnh đều được
        // chuyển sang luồng UI (STA) để gọi được API clipboard của Windows.
        _win = new HiddenWindow();
        IntPtr h = _win.Handle;
        GC.KeepAlive(h);

        Thread writer = new Thread(WriterLoop);
        writer.IsBackground = true;
        writer.Start();

        Thread reader = new Thread(StdinLoop);
        reader.IsBackground = true;
        reader.Start();

        Emit("{\"t\":\"ready\",\"version\":\"1.1\",\"pid\":" + Process.GetCurrentProcess().Id +
             ",\"arch\":\"" + (IntPtr.Size == 8 ? "x64" : "x86") + "\"}");

        InstallKeyboardHook();
        InstallForegroundHook();

        // Gộp nhiều thông báo clipboard trong cùng một lần copy thành một lần đọc duy nhất,
        // nhờ vậy mọi định dạng (text + HTML + SourceURL + ảnh) đã sẵn sàng.
        _debounce = new System.Windows.Forms.Timer();
        _debounce.Interval = 140;
        _debounce.Tick += new EventHandler(OnDebounceTick);
        _debounce.Stop();

        EmitFocus(true);

        try
        {
            // ApplicationContext rỗng: chạy vòng lặp thông điệp mà không hiển thị cửa sổ nào
            Application.Run(new ApplicationContext());
        }
        catch (Exception ex)
        {
            EmitError("mainloop", ex);
        }

        Cleanup();
    }

    private static void Cleanup()
    {
        try { if (_kbHook != IntPtr.Zero) Native.UnhookWindowsHookEx(_kbHook); } catch { }
        try { if (_winEventHook != IntPtr.Zero) Native.UnhookWinEvent(_winEventHook); } catch { }
        try { if (_win != null) Native.RemoveClipboardFormatListener(_win.Handle); } catch { }
    }

    // ---------------- Xuất JSON ra stdout ----------------

    private static void WriterLoop()
    {
        Stream so = Console.OpenStandardOutput();
        StreamWriter sw = new StreamWriter(so, new UTF8Encoding(false), 8192);
        sw.AutoFlush = true;
        while (true)
        {
            string line;
            if (OutQueue.TryDequeue(out line))
            {
                try { sw.Write(line); sw.Write('\n'); }
                catch { return; }
            }
            else
            {
                Thread.Sleep(6);
            }
        }
    }

    private static void Emit(string json)
    {
        if (OutQueue.Count > 4000) return;   // chống tràn bộ nhớ nếu bên đọc bị treo
        OutQueue.Enqueue(json);
    }

    public static void EmitError(string where, Exception ex)
    {
        Emit("{\"t\":\"error\",\"where\":" + J(where) + ",\"message\":" + J(ex.Message) + "}");
    }

    private static string J(string s)
    {
        if (s == null) return "null";
        StringBuilder sb = new StringBuilder(s.Length + 2);
        sb.Append('"');
        for (int i = 0; i < s.Length; i++)
        {
            char c = s[i];
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
                    if (c < 32 || c == '\u2028' || c == '\u2029')
                    {
                        sb.Append("\\u");
                        sb.Append(((int)c).ToString("x4"));
                    }
                    else sb.Append(c);
                    break;
            }
        }
        sb.Append('"');
        return sb.ToString();
    }

    private static long Now()
    {
        return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    }

    // ---------------- Thông tin cửa sổ / tiến trình ----------------

    private sealed class WinInfo
    {
        public IntPtr Hwnd;
        public uint Pid;
        public string Proc = "";
        public string Title = "";
        public string Exe = "";
    }

    private static WinInfo DescribeWindow(IntPtr hwnd)
    {
        WinInfo wi = new WinInfo();
        wi.Hwnd = hwnd;
        if (hwnd == IntPtr.Zero) return wi;
        try
        {
            StringBuilder sb = new StringBuilder(1024);
            Native.GetWindowTextW(hwnd, sb, sb.Capacity);
            wi.Title = sb.ToString();
        }
        catch { }
        try
        {
            uint pid;
            Native.GetWindowThreadProcessId(hwnd, out pid);
            wi.Pid = pid;
            if (pid != 0)
            {
                Process p = Process.GetProcessById((int)pid);
                wi.Proc = p.ProcessName;
                try { wi.Exe = p.MainModule != null ? p.MainModule.FileName : ""; }
                catch { }
            }
        }
        catch { }
        return wi;
    }

    private static string IdentityOf(string proc, string title)
    {
        // Bỏ phần tiêu đề hay đổi (số, tên file) để so sánh "cùng một ngữ cảnh"
        string t = title == null ? "" : title;
        if (t.Length > 60) t = t.Substring(0, 60);
        return (proc == null ? "" : proc.ToLowerInvariant()) + "|" + t;
    }

    public static void EmitFocus(bool force)
    {
        IntPtr fg = Native.GetForegroundWindow();
        WinInfo wi = DescribeWindow(fg);
        string key = IdentityOf(wi.Proc, wi.Title);
        long now = Now();
        if (!force && key == _lastFocusKey && now - _lastFocusEmit < 1500) return;
        _lastFocusKey = key;
        _lastFocusEmit = now;
        Emit("{\"t\":\"focus\",\"hwnd\":" + wi.Hwnd.ToInt64() + ",\"pid\":" + wi.Pid +
             ",\"proc\":" + J(wi.Proc) + ",\"title\":" + J(wi.Title) + ",\"exe\":" + J(wi.Exe) +
             ",\"ts\":" + now + "}");
    }

    private static void InstallForegroundHook()
    {
        _winEventProc = new Native.WinEventDelegate(OnWinEvent);
        _winEventHook = Native.SetWinEventHook(Native.EVENT_SYSTEM_FOREGROUND, Native.EVENT_SYSTEM_FOREGROUND,
            IntPtr.Zero, _winEventProc, 0, 0,
            Native.WINEVENT_OUTOFCONTEXT | Native.WINEVENT_SKIPOWNPROCESS);
    }

    private static void OnWinEvent(IntPtr hWinEventHook, uint eventType, IntPtr hwnd,
        int idObject, int idChild, uint dwEventThread, uint dwmsEventTime)
    {
        if (eventType != Native.EVENT_SYSTEM_FOREGROUND) return;
        try { EmitFocus(false); }
        catch { }
    }

    // ---------------- Bắt Ctrl+V ----------------

    private static void InstallKeyboardHook()
    {
        if (_noKbHook) return;
        _kbProc = new Native.LowLevelKeyboardProc(KbCallback);
        IntPtr hMod = Native.GetModuleHandleW(null);
        _kbHook = Native.SetWindowsHookEx(Native.WH_KEYBOARD_LL, _kbProc, hMod, 0);
        if (_kbHook == IntPtr.Zero)
        {
            int err = Marshal.GetLastWin32Error();
            Emit("{\"t\":\"hookfail\",\"code\":" + err + "}");
        }
    }

    private static IntPtr KbCallback(int nCode, IntPtr wParam, IntPtr lParam)
    {
        try
        {
            if (nCode >= 0 && !_injecting)
            {
                int msg = wParam.ToInt32();
                if (msg == Native.WM_KEYDOWN || msg == Native.WM_SYSKEYDOWN)
                {
                    Native.KBDLLHOOKSTRUCT kb = (Native.KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(Native.KBDLLHOOKSTRUCT));
                    bool ctrl = (Native.GetAsyncKeyState(Native.VK_CONTROL) & 0x8000) != 0;
                    bool shift = (Native.GetAsyncKeyState(Native.VK_SHIFT) & 0x8000) != 0;
                    bool alt = (Native.GetAsyncKeyState(Native.VK_MENU) & 0x8000) != 0;
                    bool isPaste = false;
                    string chord = "";
                    if (kb.vkCode == Native.VK_V && ctrl && !alt)
                    {
                        isPaste = true;
                        chord = shift ? "ctrl+shift+v" : "ctrl+v";
                    }
                    else if (kb.vkCode == Native.VK_INSERT && shift && !ctrl && !alt)
                    {
                        isPaste = true;
                        chord = "shift+insert";
                    }
                    if (isPaste)
                    {
                        IntPtr fg = Native.GetForegroundWindow();
                        WinInfo wi = DescribeWindow(fg);
                        Emit("{\"t\":\"paste\",\"chord\":" + J(chord) + ",\"hwnd\":" + wi.Hwnd.ToInt64() +
                             ",\"pid\":" + wi.Pid + ",\"proc\":" + J(wi.Proc) + ",\"title\":" + J(wi.Title) +
                             ",\"seq\":" + Native.GetClipboardSequenceNumber() + ",\"ts\":" + Now() + "}");
                        EmitFocus(true);
                    }
                }
            }
        }
        catch { }
        return Native.CallNextHookEx(_kbHook, nCode, wParam, lParam);
    }

    // ---------------- Đọc clipboard ----------------

    private static IDataObject ReadClipboardWithRetry()
    {
        for (int i = 0; i < 8; i++)
        {
            try
            {
                IDataObject d = Clipboard.GetDataObject();
                if (d != null) return d;
            }
            catch { }
            Thread.Sleep(25);
        }
        return null;
    }

    public static void OnClipboardUpdate()
    {
        // Hẹn giờ đọc lại sau khi clipboard "lắng" (gộp nhiều thông báo liên tiếp)
        try
        {
            _debounce.Stop();
            _debounce.Start();
        }
        catch { }
    }

    private static void OnDebounceTick(object sender, EventArgs e)
    {
        _debounce.Stop();
        try { ProcessClipboard(); }
        catch (Exception ex) { EmitError("clipboard", ex); }
    }

    private static void ProcessClipboard()
    {
        lock (ClipLock)
        {
            uint seq = Native.GetClipboardSequenceNumber();
            _lastSeq = seq;

            // Nếu chính ta vừa ghi clipboard (dán lại / xoá) thì không lưu lại.
            if (Now() < _suppressUntil)
            {
                _lastEmittedSeq = seq;
                return;
            }

            IDataObject data = ReadClipboardWithRetry();
            if (data == null)
            {
                Emit("{\"t\":\"clip\",\"seq\":" + seq + ",\"kind\":\"unavailable\",\"ts\":" + Now() + "}");
                return;
            }

            string text = null;
            string html = null;
            string sourceUrl = null;
            string imageFile = null;
            int imgW = 0, imgH = 0;
            List<string> files = new List<string>();

            // 1) HTML thô (CF_HTML) - chứa SourceURL => biết trang nguồn
            try
            {
                if (data.GetDataPresent("HTML Format"))
                {
                    object o = data.GetData("HTML Format");
                    if (o is string)
                    {
                        html = (string)o;
                        sourceUrl = ExtractSourceUrl(html);
                        html = ExtractFragment(html);
                    }
                }
            }
            catch { }

            // 2) Văn bản thuần
            try
            {
                if (data.GetDataPresent(DataFormats.UnicodeText))
                    text = data.GetData(DataFormats.UnicodeText) as string;
                else if (data.GetDataPresent(DataFormats.Text))
                    text = data.GetData(DataFormats.Text) as string;
            }
            catch { }

            // 3) Ảnh
            bool hasImage = false;
            try { hasImage = data.GetDataPresent(DataFormats.Bitmap) || data.GetDataPresent("PNG"); }
            catch { }
            if (hasImage)
            {
                try
                {
                    if (data.GetDataPresent("PNG"))
                    {
                        object po = data.GetData("PNG");
                        MemoryStream pms = po as MemoryStream;
                        if (pms != null)
                        {
                            byte[] pb = pms.ToArray();
                            if (pb.Length > 16)
                            {
                                string p = Path.Combine(_tmpDir, "clip_" + seq + "_" + Now() + ".png");
                                File.WriteAllBytes(p, pb);
                                imageFile = p;
                            }
                        }
                    }
                    if (imageFile == null && data.GetDataPresent(DataFormats.Bitmap))
                    {
                        object io = data.GetData(DataFormats.Bitmap);
                        Image img = io as Image;
                        if (img != null)
                        {
                            string p = Path.Combine(_tmpDir, "clip_" + seq + "_" + Now() + ".png");
                            using (Bitmap bmp = new Bitmap(img.Width, img.Height, PixelFormat.Format32bppArgb))
                            {
                                using (Graphics g = Graphics.FromImage(bmp))
                                {
                                    g.Clear(Color.Transparent);
                                    g.DrawImage(img, 0, 0, img.Width, img.Height);
                                }
                                bmp.Save(p, ImageFormat.Png);
                            }
                            imageFile = p;
                        }
                    }
                    if (imageFile != null)
                    {
                        using (Image chk = Image.FromFile(imageFile))
                        {
                            imgW = chk.Width; imgH = chk.Height;
                        }
                    }
                }
                catch { imageFile = null; }
            }

            // 4) Danh sách tệp
            try
            {
                if (data.GetDataPresent(DataFormats.FileDrop))
                {
                    string[] arr = data.GetData(DataFormats.FileDrop) as string[];
                    if (arr != null) files.AddRange(arr);
                }
            }
            catch { }

            string kind;
            if (imageFile != null) kind = "image";
            else if (files.Count > 0 && string.IsNullOrEmpty(text)) kind = "files";
            else if (!string.IsNullOrEmpty(text)) kind = "text";
            else if (!string.IsNullOrEmpty(html)) kind = "html";
            else kind = "empty";

            // Chống trùng: cùng nội dung + cùng cửa sổ nguồn trong thời gian ngắn => bỏ qua.
            // Nhiều ứng dụng phát nhiều thông báo cho CÙNG một lần copy.
            string fp = kind + "|" + (text ?? "") + "|" + (imageFile != null ? Path.GetFileName(imageFile) : "") +
                        "|" + (sourceUrl ?? "") + "|" + files.Count;
            long nowMs = Now();
            if (seq == _lastEmittedSeq) return;
            if (fp == _lastFingerprint && nowMs - _lastEmitTime < 900) return;
            _lastFingerprint = fp;
            _lastEmitTime = nowMs;
            _lastEmittedSeq = seq;

            WinInfo fg = DescribeWindow(Native.GetForegroundWindow());

            StringBuilder sb = new StringBuilder(256 + (text != null ? text.Length : 0));
            sb.Append("{\"t\":\"clip\",\"seq\":").Append(seq);
            sb.Append(",\"kind\":").Append(J(kind));
            sb.Append(",\"ts\":").Append(Now());
            sb.Append(",\"text\":").Append(text == null ? "null" : J(text));
            sb.Append(",\"html\":").Append(html == null ? "null" : J(html));
            sb.Append(",\"sourceUrl\":").Append(sourceUrl == null ? "null" : J(sourceUrl));
            sb.Append(",\"imageFile\":").Append(imageFile == null ? "null" : J(imageFile));
            sb.Append(",\"width\":").Append(imgW);
            sb.Append(",\"height\":").Append(imgH);
            sb.Append(",\"files\":[");
            for (int i = 0; i < files.Count; i++)
            {
                if (i > 0) sb.Append(',');
                sb.Append(J(files[i]));
            }
            sb.Append("],\"srcProc\":").Append(J(fg.Proc));
            sb.Append(",\"srcTitle\":").Append(J(fg.Title));
            sb.Append(",\"srcPid\":").Append(fg.Pid);
            sb.Append(",\"srcHwnd\":").Append(fg.Hwnd.ToInt64());
            sb.Append('}');
            Emit(sb.ToString());
        }
    }

    private static readonly Regex RxSourceUrl = new Regex(@"SourceURL:\s*(\S+)", RegexOptions.IgnoreCase);
    private static readonly Regex RxStartFrag = new Regex(@"StartFragment:(\d+)", RegexOptions.IgnoreCase);
    private static readonly Regex RxEndFrag = new Regex(@"EndFragment:(\d+)", RegexOptions.IgnoreCase);

    private static string ExtractSourceUrl(string raw)
    {
        if (string.IsNullOrEmpty(raw)) return null;
        Match m = RxSourceUrl.Match(raw);
        if (m.Success)
        {
            string u = m.Groups[1].Value.Trim();
            if (u.Length > 0) return u;
        }
        return null;
    }

    private static string ExtractFragment(string raw)
    {
        if (string.IsNullOrEmpty(raw)) return null;
        Match s = RxStartFrag.Match(raw);
        Match e = RxEndFrag.Match(raw);
        if (s.Success && e.Success)
        {
            int a, b;
            if (int.TryParse(s.Groups[1].Value, out a) && int.TryParse(e.Groups[1].Value, out b))
            {
                if (a >= 0 && b > a && b <= raw.Length)
                {
                    string frag = raw.Substring(a, b - a);
                    if (frag.Trim().Length > 0) return frag;
                }
            }
        }
        // Dự phòng: bỏ phần header CF_HTML
        int idx = raw.IndexOf("<html", StringComparison.OrdinalIgnoreCase);
        if (idx < 0) idx = raw.IndexOf("<!--StartFragment-->", StringComparison.OrdinalIgnoreCase);
        if (idx > 0) return raw.Substring(idx);
        return raw;
    }

    // ---------------- Phím tắt toàn cục ----------------

    public static void OnHotkey(int id)
    {
        Emit("{\"t\":\"hotkey\",\"id\":" + id + ",\"ts\":" + Now() + "}");
    }

    // ---------------- Lệnh từ stdin ----------------

    private static void StdinLoop()
    {
        try
        {
            Stream si = Console.OpenStandardInput();
            StreamReader sr = new StreamReader(si, new UTF8Encoding(false));
            string line;
            while ((line = sr.ReadLine()) != null)
            {
                line = line.Trim();
                if (line.Length == 0) continue;
                // Mọi lệnh được thực thi trên luồng UI (STA) — bắt buộc với API clipboard.
                string captured = line;
                try
                {
                    if (_win != null && _win.IsHandleCreated)
                        _win.BeginInvoke((MethodInvoker)delegate { HandleCommand(captured); });
                    else
                        HandleCommand(captured);
                }
                catch (Exception ex) { EmitError("cmd", ex); }
            }
        }
        catch { }
        // stdin đóng => tiến trình cha đã thoát
        try { Environment.Exit(0); } catch { }
    }

    /// <summary>
    /// Xử lý một lệnh JSON từ tiến trình cha (Node).
    /// Hỗ trợ: ping, focus, paste, hotkey, unhotkey, snapshot, quit,
    ///         settext, setimage, setfiles, clearcip, target.
    /// </summary>
    private static void HandleCommand(string line)
    {
        Dictionary<string, object> msg;
        try { msg = Json.ParseObject(line); }
        catch (Exception ex) { EmitError("json", ex); return; }
        string cmd = Json.Str(msg, "cmd");
        if (cmd == null) return;

        if (cmd == "ping")
        {
            Emit("{\"t\":\"pong\",\"ts\":" + Now() + "}");
        }
        else if (cmd == "focus")
        {
            string needle = Json.Str(msg, "title");
            IntPtr target = FindWindowByTitle(needle);
            bool ok = target != IntPtr.Zero && ForceForeground(target);
            Emit("{\"t\":\"focusresult\",\"ok\":" + (ok ? "true" : "false") + ",\"hwnd\":" + target.ToInt64() +
                 ",\"ts\":" + Now() + "}");
        }
        else if (cmd == "paste")
        {
            IntPtr target = ResolveTarget(msg);
            bool ok = SendPaste(target);
            Emit("{\"t\":\"pasted\",\"hwnd\":" + target.ToInt64() + ",\"ok\":" + (ok ? "true" : "false") +
                 ",\"ts\":" + Now() + "}");
        }
        else if (cmd == "hotkey")
        {
            int id = (int)Json.Num(msg, "id", 1);
            uint mods = (uint)Json.Num(msg, "mods", 0);
            uint vk = (uint)Json.Num(msg, "vk", 0);
            bool ok = false;
            if (_win != null && vk != 0) ok = Native.RegisterHotKey(_win.Handle, id, mods, vk);
            Emit("{\"t\":\"hotkeyreg\",\"id\":" + id + ",\"ok\":" + (ok ? "true" : "false") +
                 ",\"err\":" + Marshal.GetLastWin32Error() + "}");
        }
        else if (cmd == "unhotkey")
        {
            int id = (int)Json.Num(msg, "id", 1);
            bool ok = _win != null && Native.UnregisterHotKey(_win.Handle, id);
            Emit("{\"t\":\"hotkeyunreg\",\"id\":" + id + ",\"ok\":" + (ok ? "true" : "false") + "}");
        }
        else if (cmd == "snapshot")
        {
            ProcessClipboard();
        }
        // ---------------- Đưa nội dung trở lại clipboard ----------------
        else if (cmd == "settext")
        {
            string text = Json.Str(msg, "text");
            string fragment = Json.Str(msg, "html");
            string url = Json.Str(msg, "url");
            SuppressCapture();
            try
            {
                DataObject d = new DataObject();
                d.SetData(DataFormats.UnicodeText, text == null ? "" : text);
                if (!string.IsNullOrEmpty(fragment))
                    d.SetData("HTML Format", BuildCfHtml(fragment, url));
                Clipboard.SetDataObject(d, true, 12, 90);
                Emit("{\"t\":\"setok\",\"what\":\"text\",\"seq\":" + Native.GetClipboardSequenceNumber() +
                     ",\"ts\":" + Now() + "}");
            }
            catch (Exception ex) { EmitError("settext", ex); }
        }
        else if (cmd == "setimage")
        {
            string p = Json.Str(msg, "path");
            SuppressCapture();
            try
            {
                using (Image img = Image.FromFile(p))
                {
                    using (Bitmap copy = new Bitmap(img.Width, img.Height, PixelFormat.Format32bppArgb))
                    {
                        using (Graphics g = Graphics.FromImage(copy))
                        {
                            g.Clear(Color.Transparent);
                            g.DrawImage(img, 0, 0, img.Width, img.Height);
                        }
                        Clipboard.SetImage(copy);
                    }
                }
                Emit("{\"t\":\"setok\",\"what\":\"image\",\"seq\":" + Native.GetClipboardSequenceNumber() +
                     ",\"ts\":" + Now() + "}");
            }
            catch (Exception ex) { EmitError("setimage", ex); }
        }
        else if (cmd == "setfiles")
        {
            List<string> paths = Json.StrList(msg, "paths");
            SuppressCapture();
            try
            {
                StringCollection sc = new StringCollection();
                foreach (string s in paths) if (File.Exists(s) || Directory.Exists(s)) sc.Add(s);
                DataObject d = new DataObject();
                d.SetData(DataFormats.FileDrop, sc);
                if (paths.Count > 0) d.SetData(DataFormats.UnicodeText, string.Join("\r\n", paths.ToArray()));
                Clipboard.SetDataObject(d, true, 12, 90);
                Emit("{\"t\":\"setok\",\"what\":\"files\",\"count\":" + sc.Count +
                     ",\"seq\":" + Native.GetClipboardSequenceNumber() + ",\"ts\":" + Now() + "}");
            }
            catch (Exception ex) { EmitError("setfiles", ex); }
        }
        else if (cmd == "clearcip")
        {
            SuppressCapture();
            try
            {
                Clipboard.Clear();
                Emit("{\"t\":\"setok\",\"what\":\"clear\",\"seq\":" + Native.GetClipboardSequenceNumber() +
                     ",\"ts\":" + Now() + "}");
            }
            catch (Exception ex) { EmitError("clearcip", ex); }
        }
        else if (cmd == "target")
        {
            // Đặt cửa sổ đích cho lần dán kế tiếp
            IntPtr t = ResolveTarget(msg);
            Emit("{\"t\":\"targetset\",\"hwnd\":" + t.ToInt64() + ",\"ts\":" + Now() + "}");
        }
        else if (cmd == "quit")
        {
            Cleanup();
            Environment.Exit(0);
        }
    }

    private static IntPtr ResolveTarget(Dictionary<string, object> msg)
    {
        long hv = Json.Num(msg, "hwnd", 0);
        IntPtr target = hv != 0 ? new IntPtr(hv) : IntPtr.Zero;
        if (target == IntPtr.Zero) target = Native.GetForegroundWindow();
        return target;
    }

    /// <summary>
    /// Trong khoảng thời gian ngắn sau khi CHÍNH TA ghi clipboard, bỏ qua thông báo
    /// WM_CLIPBOARDUPDATE để không tự lưu lại nội dung mình vừa đặt.
    /// </summary>
    private static void SuppressCapture()
    {
        _suppressUntil = Now() + 1800;
    }

    private static string BuildCfHtml(string fragment, string url)
    {
        string header = "Version:1.0\r\n" +
                        "StartHTML:{0:D10}\r\n" +
                        "EndHTML:{1:D10}\r\n" +
                        "StartFragment:{2:D10}\r\n" +
                        "EndFragment:{3:D10}\r\n" +
                        (string.IsNullOrEmpty(url) ? "" : "SourceURL:" + url + "\r\n");
        string pre = "<html><body><!--StartFragment-->";
        string post = "<!--EndFragment--></body></html>";
        int headerLen = string.Format(header, 0, 0, 0, 0).Length;
        int startHtml = headerLen;
        int startFrag = startHtml + pre.Length;
        int endFrag = startFrag + Encoding.UTF8.GetByteCount(fragment);
        int endHtml = endFrag + post.Length;
        return string.Format(header, startHtml, endHtml, startFrag, endFrag) + pre + fragment + post;
    }


    // Tìm cửa sổ theo tiêu đề (duyệt toàn bộ cửa sổ cấp cao nhất)
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    private static IntPtr FindWindowByTitle(string needle)
    {
        if (string.IsNullOrEmpty(needle)) return IntPtr.Zero;
        IntPtr found = IntPtr.Zero;
        string low = needle.ToLowerInvariant();
        EnumWindows(delegate(IntPtr h, IntPtr l)
        {
            if (!IsWindowVisible(h)) return true;
            StringBuilder sb = new StringBuilder(512);
            Native.GetWindowTextW(h, sb, sb.Capacity);
            string t = sb.ToString();
            if (t.Length > 0 && t.ToLowerInvariant().Contains(low))
            {
                found = h;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    /// <summary>
    /// Đưa một cửa sổ lên trước. Windows chặn SetForegroundWindow nếu tiến trình
    /// không phải ứng dụng đang được người dùng tương tác, nên phải thử lần lượt
    /// ba cách: trực tiếp → AttachThreadInput → mẹo nhấn ALT.
    /// </summary>
    private static bool ForceForeground(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero) return false;
        try
        {
            if (Native.IsIconic(hwnd)) Native.ShowWindow(hwnd, 9);   // SW_RESTORE

            for (int attempt = 0; attempt < 3; attempt++)
            {
                if (Native.GetForegroundWindow() == hwnd) return true;

                if (attempt == 0)
                {
                    Native.SetForegroundWindow(hwnd);
                }
                else if (attempt == 1)
                {
                    uint fgPid;
                    uint fgThread = Native.GetWindowThreadProcessId(Native.GetForegroundWindow(), out fgPid);
                    uint cur = Native.GetCurrentThreadId();
                    bool attached = false;
                    if (fgThread != 0 && fgThread != cur)
                        attached = Native.AttachThreadInput(cur, fgThread, true);
                    Native.BringWindowToTop(hwnd);
                    Native.SetForegroundWindow(hwnd);
                    if (attached) Native.AttachThreadInput(cur, fgThread, false);
                }
                else
                {
                    // Nhấn nhả phím ALT làm Windows "mở khoá" quyền đặt foreground
                    Native.keybd_event(Native.VK_MENU, 0, 0, UIntPtr.Zero);
                    Thread.Sleep(12);
                    Native.SetForegroundWindow(hwnd);
                    Native.keybd_event(Native.VK_MENU, 0, Native.KEYEVENTF_KEYUP, UIntPtr.Zero);
                }
                Thread.Sleep(70);
            }
            return Native.GetForegroundWindow() == hwnd;
        }
        catch { return false; }
    }

    /// <summary>
    /// Gửi Ctrl+V vào cửa sổ đích. AN TOÀN: chỉ gửi khi đã xác nhận cửa sổ đích
    /// thực sự đang được focus — tránh dán nhầm vào ứng dụng khác của người dùng.
    /// </summary>
    private static bool SendPaste(IntPtr target)
    {
        _injecting = true;
        try
        {
            if (target != IntPtr.Zero && Native.GetForegroundWindow() != target)
            {
                ForceForeground(target);
                Thread.Sleep(60);
            }
            if (target != IntPtr.Zero && Native.GetForegroundWindow() != target)
            {
                // Không giành được focus -> KHÔNG dán bừa vào cửa sổ khác.
                return false;
            }
            Native.keybd_event(Native.VK_CONTROL, 0, 0, UIntPtr.Zero);
            Thread.Sleep(12);
            Native.keybd_event(Native.VK_V, 0, 0, UIntPtr.Zero);
            Thread.Sleep(20);
            Native.keybd_event(Native.VK_V, 0, Native.KEYEVENTF_KEYUP, UIntPtr.Zero);
            Thread.Sleep(12);
            Native.keybd_event(Native.VK_CONTROL, 0, Native.KEYEVENTF_KEYUP, UIntPtr.Zero);
            return true;
        }
        catch { return false; }
        finally
        {
            Thread.Sleep(220);
            _injecting = false;
        }
    }
}

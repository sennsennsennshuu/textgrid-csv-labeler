#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]
//! TextGrid / CSV 标注工具桌面入口。
//! 前端直接内嵌正式网页；Rust 只在 IPv4 回环地址提供只读页面和无数据的生命周期通知。
//! 无第三方 Rust 依赖、无解压步骤、无用户数据上传或独立资源文件。
use std::{
    env,
    io::{self, Read, Write},
    net::{TcpListener, TcpStream},
    path::PathBuf,
    process::{Command, ExitCode},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

const VERSION: &str = "1.0.0";
const HTML: &str = include_str!("../ui/textgrid.html");
const PAGE_SHA256: &str = "7398246de2deb957ac05853ff8c93c9051d22ed7b6dde8b77f333c38d1c15ce0";
const TITLE: &str = "TextGrid标注工具";

// 生命周期脚本只发送空通知，不访问 File/Blob、音频、标注或编辑历史。
// pagehide 仅在用户通过网页已有的未保存确认之后发生；刷新由下一页 pulse 取消关闭。
const LIFECYCLE: &str = r#"<script id="desktop-lifecycle">
(() => {
  const base = new URL('.', location.href);
  const pulse = () => fetch(new URL('desktop/pulse', base), {
    method: 'POST', body: '', credentials: 'omit', cache: 'no-store', keepalive: true
  }).catch(() => {});
  pulse();
  setInterval(pulse, 2000);
  addEventListener('pageshow', pulse);
  addEventListener('pagehide', () => {
    navigator.sendBeacon(new URL('desktop/close', base), '');
  });
})();
</script>"#;

#[derive(Clone, Copy)]
enum Method { Get, Head, Post, Other }

struct Lifecycle {
    opened: bool,
    last_pulse: Instant,
    closing: Option<Instant>,
}

#[cfg(windows)]
fn random_token() -> io::Result<String> {
    // 使用 Windows 系统密码学随机源，能力 URL 无法根据进程号或时间预测。
    #[link(name = "bcrypt")]
    unsafe extern "system" {
        fn BCryptGenRandom(algorithm: *mut std::ffi::c_void, buffer: *mut u8, length: u32, flags: u32) -> i32;
    }
    let mut bytes = [0_u8; 32];
    let status = unsafe { BCryptGenRandom(std::ptr::null_mut(), bytes.as_mut_ptr(), bytes.len() as u32, 2) };
    if status < 0 { return Err(io::Error::other(format!("BCryptGenRandom 失败：{status}"))); }
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[cfg(not(windows))]
fn random_token() -> io::Result<String> {
    let mut bytes = [0_u8; 32];
    std::fs::File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn desktop_page() -> String {
    // 不修改任何可见 DOM、CSS 或标注业务脚本，只在原网页末尾加入窗口生命周期通知。
    HTML.replacen("</body>", &format!("{LIFECYCLE}</body>"), 1)
}

fn response(stream: &mut TcpStream, status: &str, content_type: &str, bytes: &[u8], head: bool) -> io::Result<()> {
    let headers = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\n\
         Connection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n\
         Referrer-Policy: no-referrer\r\nX-Frame-Options: DENY\r\n\
         Cross-Origin-Opener-Policy: same-origin\r\n\
         Content-Security-Policy: default-src 'self' blob: data:; script-src 'self' 'unsafe-inline' blob:; \
         style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; worker-src blob:; \
         connect-src 'self'; media-src blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'\r\n\
         \r\n", bytes.len()
    );
    stream.write_all(headers.as_bytes())?;
    if !head { stream.write_all(bytes)?; }
    stream.flush()
}

fn handle(mut stream: TcpStream, expected_host: &str, prefix: &str, page: &str, state: &Mutex<Lifecycle>) -> io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(3)))?;
    stream.set_write_timeout(Some(Duration::from_secs(5)))?;
    // 请求头限制 32 KiB，任何非空请求体均被拒绝；此服务不提供文件上传或写入 API。
    let mut data = Vec::with_capacity(2048);
    let mut buf = [0_u8; 2048];
    let header_end = loop {
        let count = stream.read(&mut buf)?;
        if count == 0 { return Ok(()); }
        data.extend_from_slice(&buf[..count]);
        if let Some(index) = data.windows(4).position(|part| part == b"\r\n\r\n") { break index + 4; }
        if data.len() > 32768 { return response(&mut stream, "431 Request Header Fields Too Large", "text/plain", b"", false); }
    };
    if header_end > 32768 { return response(&mut stream, "431 Request Header Fields Too Large", "text/plain", b"", false); }
    let request = std::str::from_utf8(&data[..header_end]).map_err(|_| io::Error::other("HTTP 请求头编码无效"))?;
    let mut lines = request.split("\r\n");
    let mut first = lines.next().unwrap_or("").split_ascii_whitespace();
    let method = match first.next() { Some("GET") => Method::Get, Some("HEAD") => Method::Head, Some("POST") => Method::Post, _ => Method::Other };
    let target = first.next().unwrap_or("");
    let route = target.split('?').next().unwrap_or("");
    let head = matches!(method, Method::Head);
    let mut host = None;
    let mut origin = None;
    let mut body_length = None;
    let mut invalid_body = false;
    for line in lines.filter(|line| !line.is_empty()) {
        let Some((name, value)) = line.split_once(':') else { return response(&mut stream, "400 Bad Request", "text/plain", b"", head); };
        let value = value.trim();
        if name.eq_ignore_ascii_case("host") {
            if host.replace(value).is_some() { return response(&mut stream, "400 Bad Request", "text/plain", b"", head); }
        } else if name.eq_ignore_ascii_case("origin") {
            origin = Some(value);
        } else if name.eq_ignore_ascii_case("content-length") {
            if body_length.replace(value).is_some() || value != "0" { invalid_body = true; }
        } else if name.eq_ignore_ascii_case("transfer-encoding") { invalid_body = true; }
    }
    if host != Some(expected_host) { return response(&mut stream, "403 Forbidden", "text/plain", b"", head); }
    if invalid_body || data.len() > header_end { return response(&mut stream, "413 Content Too Large", "text/plain", b"", head); }
    if !route.starts_with(prefix) { return response(&mut stream, "404 Not Found", "text/plain", b"", head); }
    let suffix = &route[prefix.len()..];
    if matches!(method, Method::Get | Method::Head) {
        return match suffix {
            "" | "index.html" => response(&mut stream, "200 OK", "text/html; charset=utf-8", page.as_bytes(), head),
            "health" => {
                let json = format!("{{\"status\":\"ok\",\"version\":\"{VERSION}\",\"page_sha256\":\"{PAGE_SHA256}\",\"data_upload\":false}}");
                response(&mut stream, "200 OK", "application/json", json.as_bytes(), head)
            }
            _ => response(&mut stream, "404 Not Found", "text/plain", b"", head),
        };
    }
    if matches!(method, Method::Post) && matches!(suffix, "desktop/pulse" | "desktop/close") {
        // 除随机令牌外，再检查精确 Origin。跨站请求不能操纵桌面窗口生命周期。
        if origin != Some(format!("http://{expected_host}").as_str()) {
            return response(&mut stream, "403 Forbidden", "text/plain", b"", false);
        }
        let mut lifecycle = state.lock().map_err(|_| io::Error::other("生命周期锁失效"))?;
        lifecycle.opened = true;
        lifecycle.last_pulse = Instant::now();
        lifecycle.closing = if suffix == "desktop/close" { Some(Instant::now()) } else { None };
        return response(&mut stream, "204 No Content", "text/plain", b"", false);
    }
    response(&mut stream, "405 Method Not Allowed", "text/plain", b"", head)
}

fn edge_path() -> io::Result<PathBuf> {
    for key in ["ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"] {
        if let Some(base) = env::var_os(key) {
            let path = PathBuf::from(base).join("Microsoft").join("Edge").join("Application").join("msedge.exe");
            if path.is_file() { return Ok(path); }
        }
    }
    // 部分桌面启动器会过滤环境变量，因此同时检查 Windows 的标准安装目录。
    for base in [r"C:\Program Files (x86)", r"C:\Program Files"] {
        let path = PathBuf::from(base).join("Microsoft").join("Edge").join("Application").join("msedge.exe");
        if path.is_file() { return Ok(path); }
    }
    Err(io::Error::new(io::ErrorKind::NotFound, "未找到 Microsoft Edge。请先安装系统 Edge 后再运行本程序。"))
}

fn open_window(url: &str) -> io::Result<()> {
    let mut command = Command::new(edge_path()?);
    // 使用系统浏览器现有配置，独立 app 窗口没有地址栏；不落地 HTML 或额外程序文件。
    command.args([format!("--app={url}"), "--new-window".into(), "--no-first-run".into(), "--no-default-browser-check".into(), "--disable-features=msEdgeSidebarV2".into()]);
    #[cfg(windows)] {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command.spawn()?;
    Ok(())
}

fn serve(port: u16, open: bool) -> io::Result<()> {
    // 仅回环监听，端口由操作系统分配，不占用网站已有 8126 或开放局域网访问。
    let listener = match TcpListener::bind(("127.0.0.1", port)) {
        Ok(listener) => listener,
        Err(error) if open && error.kind() == io::ErrorKind::AddrInUse => TcpListener::bind(("127.0.0.1", 0))?,
        Err(error) => return Err(error),
    };
    listener.set_nonblocking(true)?;
    let host = listener.local_addr()?.to_string();
    let prefix = format!("/{}/", random_token()?);
    let url = format!("http://{host}{prefix}");
    let state = Arc::new(Mutex::new(Lifecycle { opened: false, last_pulse: Instant::now(), closing: None }));
    let page = Arc::new(desktop_page());
    if open { open_window(&url)?; } else { println!("{url}"); io::stdout().flush()?; }
    let started = Instant::now();
    loop {
        match listener.accept() {
            Ok((stream, _)) => {
                // 每个浏览器请求独立处理，慢连接不会阻塞音频 UI 或窗口关闭。
                let host = host.clone(); let prefix = prefix.clone(); let page = page.clone(); let state = state.clone();
                thread::spawn(move || { let _ = handle(stream, &host, &prefix, &page, &state); });
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
            Err(error) => return Err(error),
        }
        if open {
            let lifecycle = state.lock().map_err(|_| io::Error::other("生命周期锁失效"))?;
            if lifecycle.closing.is_some_and(|time| time.elapsed() > Duration::from_secs(3)) { break; }
            // 页面尚未出现时及时退出；崩溃/强杀且缺少 pagehide 的情况下也不永久驻留。
            if (!lifecycle.opened && started.elapsed() > Duration::from_secs(90))
                || (lifecycle.opened && lifecycle.last_pulse.elapsed() > Duration::from_secs(240)) { break; }
        }
        thread::sleep(Duration::from_millis(10));
    }
    Ok(())
}

fn run() -> io::Result<()> {
    let args: Vec<String> = env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("--version") => { println!("textgrid-csv-labeler {VERSION}"); Ok(()) }
        Some("--print-html") => { io::stdout().write_all(HTML.as_bytes()) }
        Some("--self-test") => {
            let token = random_token()?;
            let page = desktop_page();
            if token.len() != 64 || !token.bytes().all(|b| b.is_ascii_hexdigit()) || page.matches("id=\"desktop-lifecycle\"").count() != 1 {
                return Err(io::Error::other("内嵌页面或随机令牌自检失败"));
            }
            if !HTML.contains("<h1>TextGrid标注工具</h1>") || !HTML.contains("ph_dur") || !HTML.contains("Ctrl+Space") {
                return Err(io::Error::other("正式网页功能自检失败"));
            }
            edge_path()?;
            println!("{{\"passed\":true,\"version\":\"{VERSION}\",\"page_sha256\":\"{PAGE_SHA256}\",\"single_file\":true,\"edge_found\":true}}");
            Ok(())
        }
        Some("--serve") => {
            let port = if args.len() > 1 { args[1].parse::<u16>().map_err(|_| io::Error::other("端口必须是 0–65535"))? } else { 0 };
            serve(port, false)
        }
        // 默认端口稳定，浏览器能跨次启动保留主题偏好和已授权的文件权限；冲突时自动分配端口。
        None => serve(38727, true),
        _ => Err(io::Error::other("参数：--version、--self-test、--print-html、--serve [端口]")),
    }
}

#[cfg(windows)]
fn show_error(message: &str) {
    #[link(name = "user32")]
    unsafe extern "system" { fn MessageBoxW(hwnd: isize, text: *const u16, caption: *const u16, flags: u32) -> i32; }
    let message: Vec<u16> = message.encode_utf16().chain(Some(0)).collect();
    let caption: Vec<u16> = TITLE.encode_utf16().chain(Some(0)).collect();
    unsafe { MessageBoxW(0, message.as_ptr(), caption.as_ptr(), 0x10); }
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{TITLE}：{error}");
            // GUI 双击启动无控制台，错误必须明确呈现；命令行诊断不弹阻塞窗口。
            #[cfg(windows)]
            if env::args_os().len() == 1 { show_error(&format!("启动失败：{error}")); }
            ExitCode::FAILURE
        }
    }
}

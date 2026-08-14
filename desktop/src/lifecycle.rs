#![cfg_attr(test, allow(dead_code))]

use crate::browser_host::{BrowserMode, BrowserSession, PhysicalBounds};
use serde::{Deserialize, Serialize};
use std::env;
use std::ffi::OsString;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, ExitStatus, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

const DEFAULT_PORT: u16 = 3210;
const START_TIMEOUT: Duration = Duration::from_secs(15);
const STOP_TIMEOUT: Duration = Duration::from_secs(8);
const PROBE_INTERVAL: Duration = Duration::from_millis(150);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ProcessKind {
    Service,
    Login,
}

#[derive(Debug)]
struct ManagedChild {
    child: Child,
    input: Option<ChildStdin>,
    kind: ProcessKind,
    protocol: Arc<Mutex<ProtocolState>>,
}

#[derive(Clone, Debug, Default)]
struct ProtocolState {
    last_event: Option<ProtocolEvent>,
}

#[derive(Clone, Debug, Deserialize)]
struct ProtocolEvent {
    protocol: u8,
    event: String,
    state: String,
    code: Option<String>,
    reason: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ServicePhase {
    Stopped,
    Starting,
    Ready,
    Unhealthy,
    LoginOpen,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ServiceStatus {
    pub phase: ServicePhase,
    pub endpoint: String,
    pub detail: String,
    pub browser_mode: BrowserMode,
}

struct Inner {
    process: Option<ManagedChild>,
    browser: Option<BrowserSession>,
    phase: ServicePhase,
}

pub struct SidecarLifecycle {
    inner: Mutex<Inner>,
    port: u16,
    runtime: RuntimeSpec,
    data_dir: PathBuf,
    profile_dir: PathBuf,
    #[cfg_attr(not(windows), allow(dead_code))]
    parent_window: Option<isize>,
}

#[derive(Clone, Debug)]
struct RuntimeSpec {
    node: PathBuf,
    service_entrypoint: PathBuf,
    login_browser: PathBuf,
    working_dir: PathBuf,
    browsers_path: Option<PathBuf>,
}

impl RuntimeSpec {
    fn resolve(resource_dir: &Path) -> Result<Self, String> {
        let bundled_candidate = resource_dir.join("sidecar");
        let bundled_root = if bundled_candidate.is_dir() {
            Some(validated_bundled_root(resource_dir, &bundled_candidate)?)
        } else {
            None
        };
        if let Some(bundled_root) = bundled_root {
            let bundled_node = bundled_root.join(if cfg!(windows) { "node.exe" } else { "node" });
            let bundled_service = bundled_root.join("dist/sidecar/index.js");
            let bundled_browsers = bundled_root.join("ms-playwright");
            if bundled_node.is_file() && bundled_service.is_file() {
                return Ok(Self {
                    node: normalize_child_path(&bundled_node)?,
                    service_entrypoint: normalize_child_path(&bundled_service)?,
                    login_browser: find_chromium_executable(&bundled_browsers)?,
                    working_dir: normalize_child_path(&bundled_root)?,
                    browsers_path: Some(normalize_child_path(&bundled_browsers)?),
                });
            }
        }

        let project_root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .ok_or("desktop directory has no project parent")?
            .to_path_buf();
        let service_entrypoint = project_root.join("dist/sidecar/index.js");
        if !service_entrypoint.is_file() {
            return Err("Node sidecar is not built; run `npm run build` first".into());
        }
        let login_browser = playwright_browser_from_node(&project_root)?;
        Ok(Self {
            node: PathBuf::from("node"),
            service_entrypoint,
            login_browser,
            working_dir: project_root,
            browsers_path: None,
        })
    }

    fn spawn(
        &self,
        kind: ProcessKind,
        port: u16,
        data_dir: &Path,
        profile_dir: &Path,
        cdp_endpoint: Option<&str>,
    ) -> Result<ManagedChild, String> {
        let mut command = match kind {
            ProcessKind::Service => {
                let mut command = Command::new(&self.node);
                command
                    .arg(&self.service_entrypoint)
                    .arg("--parent-pipe")
                    .env("TAB2API_HOST", "127.0.0.1")
                    .env("TAB2API_PORT", port.to_string())
                    .env("TAB2API_BROWSER_BACKEND", "playwright")
                    .env("TAB2API_DATA_DIR", data_dir)
                    .env("TAB2API_PROFILE_DIR", profile_dir)
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped());
                if let Some(browsers_path) = &self.browsers_path {
                    command.env("PLAYWRIGHT_BROWSERS_PATH", browsers_path);
                }
                if let Some(endpoint) = cdp_endpoint {
                    command.env("TAB2API_BROWSER_CDP_ENDPOINT", endpoint);
                }
                command
            }
            ProcessKind::Login => {
                let mut command = Command::new(&self.login_browser);
                command
                    .args(login_arguments(profile_dir))
                    .stdin(Stdio::null())
                    .stdout(Stdio::null());
                command
            }
        };
        command.current_dir(&self.working_dir).stderr(Stdio::null());
        let mut child = command.spawn().map_err(|error| match kind {
            ProcessKind::Service => format!("could not start the tab2api sidecar: {error}"),
            ProcessKind::Login => format!("could not open the dedicated Chromium window: {error}"),
        })?;
        let protocol = Arc::new(Mutex::new(ProtocolState::default()));
        let input = if kind == ProcessKind::Service {
            let output = child
                .stdout
                .take()
                .ok_or("sidecar protocol output pipe was not created")?;
            read_protocol(output, Arc::clone(&protocol));
            let mut input = child
                .stdin
                .take()
                .ok_or("sidecar protocol input pipe was not created")?;
            if write_protocol_handshake(&mut input).is_err() {
                let _ = child.kill();
                let _ = child.wait();
                return Err("sidecar protocol handshake failed before startup".into());
            }
            Some(input)
        } else {
            None
        };
        Ok(ManagedChild {
            child,
            input,
            kind,
            protocol,
        })
    }
}

fn validated_bundled_root(resource_dir: &Path, bundled_root: &Path) -> Result<PathBuf, String> {
    let canonical_resource = resource_dir
        .canonicalize()
        .map_err(|_| "could not validate desktop resource directory".to_string())?;
    let canonical_bundle = bundled_root
        .canonicalize()
        .map_err(|_| "could not validate bundled sidecar directory".to_string())?;
    if !canonical_bundle.starts_with(&canonical_resource) || canonical_bundle == canonical_resource
    {
        return Err(
            "bundled sidecar must be strictly inside the desktop resource directory".into(),
        );
    }
    normalize_child_path(&canonical_bundle)
}

fn normalize_child_path(path: &Path) -> Result<PathBuf, String> {
    let Some(text) = path.to_str() else {
        return Err("desktop resource path is not valid Unicode".into());
    };
    let Some(remainder) = text.strip_prefix(r"\\?\") else {
        return Ok(path.to_path_buf());
    };
    let bytes = remainder.as_bytes();
    if bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
    {
        return Ok(PathBuf::from(remainder));
    }
    if remainder
        .get(..4)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("UNC\\"))
    {
        return Err("desktop resources must be on a local drive, not a verbatim UNC path".into());
    }
    Err("unsupported Windows verbatim desktop resource path".into())
}

fn write_protocol_handshake(output: &mut impl Write) -> std::io::Result<()> {
    output.write_all(b"{\"command\":\"status\"}\n")?;
    output.flush()
}

fn read_protocol(output: ChildStdout, state: Arc<Mutex<ProtocolState>>) {
    thread::spawn(move || {
        let reader = BufReader::new(output);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            if line.len() > 4096 {
                continue;
            }
            let Ok(event) = serde_json::from_str::<ProtocolEvent>(&line) else {
                continue;
            };
            if protocol_event_is_safe(&event)
                && let Ok(mut current) = state.lock()
            {
                current.last_event = Some(event);
            }
        }
    });
}

fn protocol_event_is_safe(event: &ProtocolEvent) -> bool {
    event.protocol == 1
        && matches!(
            event.event.as_str(),
            "starting"
                | "listening"
                | "status"
                | "stopping"
                | "stopped"
                | "fatal"
                | "protocol_error"
        )
        && matches!(
            event.state.as_str(),
            "idle" | "starting" | "listening" | "stopping" | "stopped" | "failed"
        )
        && event.code.as_deref().is_none_or(|code| {
            matches!(
                code,
                "startup_failed" | "invalid_command" | "command_too_large"
            )
        })
        && event.reason.as_deref().is_none_or(|reason| {
            matches!(
                reason,
                "parent_stream_closed" | "parent_request" | "SIGINT" | "SIGTERM"
            )
        })
}

fn sanitized_exit_detail(managed: &ManagedChild, status: ExitStatus) -> String {
    let event = managed
        .protocol
        .lock()
        .ok()
        .and_then(|state| state.last_event.clone());
    let status = status
        .code()
        .map_or_else(|| "terminated".to_string(), |code| format!("exit {code}"));
    match event {
        Some(event) if event.code.as_deref() == Some("startup_failed") => format!(
            "sidecar reported startup_failed ({status}); verify port availability and app-local data permissions"
        ),
        Some(event) if event.reason.as_deref() == Some("parent_stream_closed") => {
            format!("sidecar protocol pipe closed unexpectedly ({status}); restart the desktop app")
        }
        Some(event) => format!(
            "sidecar exited after protocol event {} ({status})",
            event.event
        ),
        None => format!("sidecar exited without a protocol event ({status})"),
    }
}

fn login_arguments(profile_dir: &Path) -> Vec<OsString> {
    vec![
        OsString::from(format!("--user-data-dir={}", profile_dir.display())),
        OsString::from("https://chatgpt.com/"),
    ]
}

fn find_chromium_executable(browsers_root: &Path) -> Result<PathBuf, String> {
    let entries = std::fs::read_dir(browsers_root).map_err(|_| {
        "bundled Playwright Chromium is missing; rebuild the desktop bundle".to_string()
    })?;
    let mut revisions = entries
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy().starts_with("chromium-"))
        .map(|entry| entry.path())
        .collect::<Vec<_>>();
    revisions.sort();
    revisions.reverse();

    let candidates: &[&str] = if cfg!(windows) {
        &["chrome-win64/chrome.exe", "chrome-win/chrome.exe"]
    } else if cfg!(target_os = "macos") {
        &[
            "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
            "chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium",
        ]
    } else {
        &["chrome-linux/chrome", "chrome-linux64/chrome"]
    };
    for revision in revisions {
        for candidate in candidates {
            let executable = revision.join(candidate);
            if executable.is_file() {
                let root = browsers_root
                    .canonicalize()
                    .map_err(|_| "could not validate bundled browser directory".to_string())?;
                let executable = executable
                    .canonicalize()
                    .map_err(|_| "could not validate bundled Chromium".to_string())?;
                if executable.starts_with(root) {
                    return normalize_child_path(&executable);
                }
            }
        }
    }
    Err("bundled Playwright Chromium executable was not found; rebuild the desktop bundle".into())
}

fn playwright_browser_from_node(project_root: &Path) -> Result<PathBuf, String> {
    let output = Command::new("node")
        .args([
            "--input-type=module",
            "--eval",
            "import { chromium } from 'playwright'; process.stdout.write(chromium.executablePath())",
        ])
        .current_dir(project_root)
        .stderr(Stdio::null())
        .output()
        .map_err(|_| "Node.js is required for desktop development".to_string())?;
    if !output.status.success() {
        return Err(
            "could not resolve Playwright Chromium; run `npx playwright install chromium`".into(),
        );
    }
    let executable = PathBuf::from(String::from_utf8_lossy(&output.stdout).trim());
    if !executable.is_file() {
        return Err(
            "Playwright Chromium is not installed; run `npx playwright install chromium`".into(),
        );
    }
    Ok(executable)
}

impl SidecarLifecycle {
    pub fn new(
        resource_dir: PathBuf,
        app_local_data_dir: PathBuf,
        parent_window: Option<isize>,
    ) -> Result<Self, String> {
        let port = match env::var("TAB2API_PORT") {
            Ok(value) => value
                .parse::<u16>()
                .map_err(|_| "TAB2API_PORT must be an integer from 1 to 65535")?,
            Err(_) => DEFAULT_PORT,
        };
        if port == 0 {
            return Err("TAB2API_PORT must not be zero".into());
        }
        let (data_dir, profile_dir) = runtime_paths(&app_local_data_dir);
        std::fs::create_dir_all(&data_dir)
            .map_err(|error| format!("could not create app data directory: {error}"))?;
        std::fs::create_dir_all(&profile_dir)
            .map_err(|error| format!("could not create browser profile directory: {error}"))?;
        Ok(Self {
            inner: Mutex::new(Inner {
                process: None,
                browser: None,
                phase: ServicePhase::Stopped,
            }),
            port,
            runtime: RuntimeSpec::resolve(&resource_dir)?,
            data_dir,
            profile_dir,
            parent_window,
        })
    }

    pub fn start(&self) -> Result<ServiceStatus, String> {
        {
            let mut inner = self.lock()?;
            Self::refresh_process(&mut inner)?;
            if inner.process.is_some() {
                return Err("tab2api is already running or the login window is open".into());
            }
            #[cfg(windows)]
            let endpoint = {
                let browser = BrowserSession::launch(
                    &self.runtime.login_browser,
                    &self.profile_dir,
                    self.parent_window,
                )?;
                let endpoint = browser.endpoint();
                inner.browser = Some(browser);
                Some(endpoint)
            };
            #[cfg(not(windows))]
            let endpoint: Option<String> = None;
            let service = self.runtime.spawn(
                ProcessKind::Service,
                self.port,
                &self.data_dir,
                &self.profile_dir,
                endpoint.as_deref(),
            );
            match service {
                Ok(service) => inner.process = Some(service),
                Err(error) => {
                    if let Some(mut browser) = inner.browser.take() {
                        browser.stop();
                    }
                    return Err(error);
                }
            }
            inner.phase = ServicePhase::Starting;
        }

        let deadline = Instant::now() + START_TIMEOUT;
        while Instant::now() < deadline {
            {
                let mut inner = self.lock()?;
                let exit_status = match inner.process.as_mut() {
                    Some(managed) => managed
                        .child
                        .try_wait()
                        .map_err(|error| format!("could not inspect tab2api: {error}"))?,
                    None => {
                        return Err(
                            "tab2api process disappeared before its health endpoint became available"
                                .into(),
                        );
                    }
                };
                if let Some(exit_status) = exit_status {
                    let managed = inner
                        .process
                        .take()
                        .ok_or("tab2api process state was lost during startup")?;
                    inner.phase = ServicePhase::Stopped;
                    if let Some(mut browser) = inner.browser.take() {
                        browser.stop();
                    }
                    return Err(sanitized_exit_detail(&managed, exit_status));
                }
            }
            if probe_health(self.port, Duration::from_millis(500)) {
                let mut inner = self.lock()?;
                inner.phase = ServicePhase::Ready;
                return self.status_locked(&mut inner);
            }
            thread::sleep(PROBE_INTERVAL);
        }

        let mut inner = self.lock()?;
        if let Some(mut service) = inner.process.take() {
            let _ = stop_managed(&mut service);
        }
        if let Some(mut browser) = inner.browser.take() {
            browser.stop();
        }
        inner.phase = ServicePhase::Stopped;
        Err("tab2api did not become healthy within 15 seconds".into())
    }

    pub fn stop(&self) -> Result<ServiceStatus, String> {
        let mut inner = self.lock()?;
        if let Some(mut managed) = inner.process.take() {
            stop_managed(&mut managed)?;
        }
        if let Some(mut browser) = inner.browser.take() {
            browser.stop();
        }
        inner.phase = ServicePhase::Stopped;
        self.status_locked(&mut inner)
    }

    pub fn open_login(&self) -> Result<ServiceStatus, String> {
        let mut inner = self.lock()?;
        Self::refresh_process(&mut inner)?;
        if inner.process.is_some() {
            return Err("stop tab2api before opening the dedicated login profile".into());
        }
        inner.process = Some(self.runtime.spawn(
            ProcessKind::Login,
            self.port,
            &self.data_dir,
            &self.profile_dir,
            None,
        )?);
        inner.phase = ServicePhase::LoginOpen;
        self.status_locked(&mut inner)
    }

    pub fn status(&self) -> Result<ServiceStatus, String> {
        let mut inner = self.lock()?;
        self.status_locked(&mut inner)
    }

    fn status_locked(&self, inner: &mut Inner) -> Result<ServiceStatus, String> {
        Self::refresh_process(inner)?;
        if matches!(
            inner.process.as_ref().map(|p| p.kind),
            Some(ProcessKind::Service)
        ) {
            inner.phase = if probe_health(self.port, Duration::from_millis(250)) {
                ServicePhase::Ready
            } else if inner.phase == ServicePhase::Starting {
                ServicePhase::Starting
            } else {
                ServicePhase::Unhealthy
            };
        }
        Ok(ServiceStatus {
            phase: inner.phase.clone(),
            endpoint: format!("http://127.0.0.1:{}", self.port),
            detail: detail_for(&inner.phase).into(),
            browser_mode: inner
                .browser
                .as_ref()
                .map_or(BrowserMode::None, BrowserSession::mode),
        })
    }

    fn refresh_process(inner: &mut Inner) -> Result<(), String> {
        if inner
            .browser
            .as_mut()
            .is_some_and(|browser| !browser.is_running())
        {
            inner.browser = None;
            if let Some(mut service) = inner.process.take() {
                let _ = stop_managed(&mut service);
            }
            inner.phase = ServicePhase::Stopped;
        }
        let Some(managed) = inner.process.as_mut() else {
            inner.phase = ServicePhase::Stopped;
            return Ok(());
        };
        if managed
            .child
            .try_wait()
            .map_err(|error| format!("could not inspect tab2api: {error}"))?
            .is_some()
        {
            inner.process = None;
            inner.phase = ServicePhase::Stopped;
        }
        Ok(())
    }

    pub fn resize_browser(&self, bounds: PhysicalBounds) -> Result<ServiceStatus, String> {
        let mut inner = self.lock()?;
        if let Some(browser) = inner.browser.as_mut() {
            browser.resize(bounds)?;
        }
        self.status_locked(&mut inner)
    }

    pub fn undock_browser(&self) -> Result<ServiceStatus, String> {
        let mut inner = self.lock()?;
        inner
            .browser
            .as_mut()
            .ok_or("browser session is not running")?
            .undock()?;
        self.status_locked(&mut inner)
    }

    pub fn redock_browser(&self) -> Result<ServiceStatus, String> {
        let mut inner = self.lock()?;
        inner
            .browser
            .as_mut()
            .ok_or("browser session is not running")?
            .redock()?;
        self.status_locked(&mut inner)
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Inner>, String> {
        self.inner
            .lock()
            .map_err(|_| "sidecar lifecycle lock is poisoned".into())
    }
}

fn runtime_paths(app_local_data_dir: &Path) -> (PathBuf, PathBuf) {
    let data_dir = app_local_data_dir.join("runtime");
    let profile_dir = data_dir.join("browser-profile");
    (data_dir, profile_dir)
}

impl Drop for SidecarLifecycle {
    fn drop(&mut self) {
        if let Ok(inner) = self.inner.get_mut()
            && let Some(mut managed) = inner.process.take()
        {
            let _ = stop_managed(&mut managed);
        }
        if let Ok(inner) = self.inner.get_mut()
            && let Some(mut browser) = inner.browser.take()
        {
            browser.stop();
        }
    }
}

fn stop_managed(managed: &mut ManagedChild) -> Result<(), String> {
    if managed.kind == ProcessKind::Service {
        if let Some(mut input) = managed.input.take() {
            let _ = input.write_all(b"{\"command\":\"shutdown\"}\n");
            let _ = input.flush();
        }
        let deadline = Instant::now() + STOP_TIMEOUT;
        while Instant::now() < deadline {
            if managed
                .child
                .try_wait()
                .map_err(|error| format!("could not inspect tab2api during shutdown: {error}"))?
                .is_some()
            {
                return Ok(());
            }
            thread::sleep(Duration::from_millis(100));
        }
    }
    managed
        .child
        .kill()
        .map_err(|error| format!("could not stop tab2api: {error}"))?;
    managed
        .child
        .wait()
        .map_err(|error| format!("could not reap tab2api: {error}"))?;
    Ok(())
}

fn detail_for(phase: &ServicePhase) -> &'static str {
    match phase {
        ServicePhase::Stopped => "The local sidecar is stopped.",
        ServicePhase::Starting => "Waiting for the local health endpoint.",
        ServicePhase::Ready => "The local API is healthy.",
        ServicePhase::Unhealthy => "The process is running but health checks are failing.",
        ServicePhase::LoginOpen => "Complete login manually in the dedicated Chromium window.",
    }
}

fn probe_health(port: u16, timeout: Duration) -> bool {
    let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
    let Ok(mut stream) = TcpStream::connect_timeout(&address, timeout) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(timeout));
    let request =
        format!("GET /healthz HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut response = [0_u8; 1024];
    let Ok(read) = stream.read(&mut response) else {
        return false;
    };
    response[..read].starts_with(b"HTTP/1.1 200")
        && response[..read]
            .windows(b"\"service\":\"tab2api\"".len())
            .any(|window| window == b"\"service\":\"tab2api\"")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn health_probe_only_targets_ipv4_loopback() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let responder = thread::spawn(move || {
            let (mut socket, peer) = listener.accept().unwrap();
            assert!(peer.ip().is_loopback());
            let mut request = [0_u8; 256];
            let read = socket.read(&mut request).unwrap();
            assert!(String::from_utf8_lossy(&request[..read]).starts_with("GET /healthz "));
            socket.write_all(
                b"HTTP/1.1 200 OK\r\nContent-Length: 39\r\n\r\n{\"status\":\"ok\",\"service\":\"tab2api\"}",
            ).unwrap();
        });
        assert!(probe_health(port, Duration::from_secs(1)));
        responder.join().unwrap();
    }

    #[test]
    fn health_probe_rejects_non_200_response() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let responder = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0_u8; 256];
            let _ = socket.read(&mut request);
            socket
                .write_all(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n")
                .unwrap();
        });
        assert!(!probe_health(port, Duration::from_secs(1)));
        responder.join().unwrap();
    }

    #[test]
    fn health_probe_rejects_unrelated_200_service() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let responder = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0_u8; 256];
            let _ = socket.read(&mut request);
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}")
                .unwrap();
        });
        assert!(!probe_health(port, Duration::from_secs(1)));
        responder.join().unwrap();
    }

    #[test]
    fn status_payload_never_contains_credentials() {
        let status = ServiceStatus {
            phase: ServicePhase::Ready,
            endpoint: "http://127.0.0.1:3210".into(),
            detail: detail_for(&ServicePhase::Ready).into(),
            browser_mode: BrowserMode::Docked,
        };
        let debug = format!("{status:?}").to_ascii_lowercase();
        assert!(!debug.contains("token"));
        assert!(!debug.contains("authorization"));
        assert!(!debug.contains("cookie"));
    }

    #[test]
    fn browser_profile_is_strictly_inside_runtime_data_directory() {
        let app_data = Path::new("app-local-data");
        let (data_dir, profile_dir) = runtime_paths(app_data);
        assert_ne!(profile_dir, data_dir);
        assert!(profile_dir.starts_with(&data_dir));
        assert_eq!(profile_dir, data_dir.join("browser-profile"));
    }

    #[test]
    fn manual_login_arguments_have_no_automation_or_debugging_switches() {
        let profile = Path::new("app-local-data/runtime/browser-profile");
        let arguments = login_arguments(profile)
            .into_iter()
            .map(|value| value.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert_eq!(arguments.len(), 2);
        assert_eq!(arguments[1], "https://chatgpt.com/");
        assert_eq!(
            arguments[0],
            format!("--user-data-dir={}", profile.display())
        );
        let joined = arguments.join(" ").to_ascii_lowercase();
        for forbidden in [
            "remote-debug",
            "automation",
            "webdriver",
            "fingerprint",
            "proxy-server",
            "disable-blink",
        ] {
            assert!(
                !joined.contains(forbidden),
                "forbidden login flag: {forbidden}"
            );
        }
    }

    #[test]
    fn protocol_diagnostics_accept_only_versioned_allowlisted_fields() {
        let valid = ProtocolEvent {
            protocol: 1,
            event: "fatal".into(),
            state: "failed".into(),
            code: Some("startup_failed".into()),
            reason: None,
        };
        assert!(protocol_event_is_safe(&valid));

        let mut invalid = valid.clone();
        invalid.code = Some("token=must-not-be-forwarded".into());
        assert!(!protocol_event_is_safe(&invalid));
        invalid = valid.clone();
        invalid.event = "arbitrary_child_output".into();
        assert!(!protocol_event_is_safe(&invalid));
        invalid = valid;
        invalid.protocol = 2;
        assert!(!protocol_event_is_safe(&invalid));
    }

    #[test]
    fn parent_pipe_handshake_is_one_bounded_protocol_command() {
        let mut output = Vec::new();
        write_protocol_handshake(&mut output).unwrap();
        assert_eq!(output, b"{\"command\":\"status\"}\n");
        assert!(output.len() < 4096);
    }

    #[test]
    fn windows_local_verbatim_path_is_normalized_for_child_processes() {
        let normalized = normalize_child_path(Path::new(
            r"\\?\C:\Program Files\tab2api\sidecar\dist\sidecar\index.js",
        ))
        .unwrap();
        assert_eq!(
            normalized,
            PathBuf::from(r"C:\Program Files\tab2api\sidecar\dist\sidecar\index.js")
        );
        assert!(!normalized.to_string_lossy().starts_with(r"\\?\"));
    }

    #[test]
    fn unsafe_verbatim_resource_paths_are_rejected() {
        assert!(normalize_child_path(Path::new(r"\\?\UNC\server\share\sidecar")).is_err());
        assert!(normalize_child_path(Path::new(r"\\?\relative\sidecar")).is_err());
        let ordinary = Path::new(r"C:\tab2api\sidecar");
        assert_eq!(normalize_child_path(ordinary).unwrap(), ordinary);
    }
}

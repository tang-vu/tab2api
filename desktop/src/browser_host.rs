// The embedded host is Windows-only; shared status/bounds types remain compiled on
// other targets so the desktop API stays portable while those private helpers rest.
#![cfg_attr(not(windows), allow(dead_code))]

use serde::Serialize;
use std::ffi::OsString;
use std::fs;
use std::io::Read;
use std::net::{Ipv4Addr, SocketAddrV4, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const PORT_FILE_LIMIT: u64 = 4096;
const START_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BrowserMode {
    None,
    External,
    Docked,
}

#[derive(Clone, Copy, Debug, serde::Deserialize)]
pub struct BrowserBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl BrowserBounds {
    pub fn physical(
        self,
        scale: f64,
        max_width: u32,
        max_height: u32,
    ) -> Result<PhysicalBounds, String> {
        if !scale.is_finite()
            || scale <= 0.0
            || ![self.x, self.y, self.width, self.height]
                .iter()
                .all(|v| v.is_finite())
        {
            return Err("browser pane bounds are invalid".into());
        }
        let converted = PhysicalBounds {
            x: (self.x * scale).round() as i32,
            y: (self.y * scale).round() as i32,
            width: (self.width * scale).round() as i32,
            height: (self.height * scale).round() as i32,
        };
        if converted.x < 0
            || converted.y < 0
            || converted.width < 160
            || converted.height < 120
            || converted.x as u32 > max_width
            || converted.y as u32 > max_height
            || converted.x as u32 + converted.width as u32 > max_width
            || converted.y as u32 + converted.height as u32 > max_height
        {
            return Err("browser pane bounds are outside the application window".into());
        }
        Ok(converted)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PhysicalBounds {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

pub struct BrowserSession {
    child: Child,
    root_pid: u32,
    port: u16,
    native: platform::NativeHost,
    port_file: PathBuf,
}

impl BrowserSession {
    pub fn launch(
        executable: &Path,
        profile: &Path,
        parent: Option<isize>,
    ) -> Result<Self, String> {
        let port_file = profile.join("DevToolsActivePort");
        if port_file.is_file() {
            fs::remove_file(&port_file)
                .map_err(|_| "could not clear stale browser control state")?;
        }
        let canonical_executable = executable
            .canonicalize()
            .map_err(|_| "could not validate bundled Chromium")?;
        let mut child = Command::new(&canonical_executable)
            .args(automation_arguments(profile))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("could not start the dedicated Chromium session: {e}"))?;
        let root_pid = child.id();
        let deadline = Instant::now() + START_TIMEOUT;
        let port = loop {
            if child
                .try_wait()
                .map_err(|e| format!("could not inspect Chromium: {e}"))?
                .is_some()
            {
                return Err(
                    "Chromium exited before its loopback control channel became available".into(),
                );
            }
            if let Ok(port) = read_devtools_port(&port_file)
                && TcpStream::connect_timeout(
                    &SocketAddrV4::new(Ipv4Addr::LOCALHOST, port).into(),
                    Duration::from_millis(250),
                )
                .is_ok()
                && platform::verify_listener_owner(port, root_pid, &canonical_executable)
            {
                break port;
            }
            if Instant::now() >= deadline {
                platform::terminate_tree(root_pid);
                let _ = child.kill();
                let _ = child.wait();
                return Err(
                    "Chromium control channel was not verified as an owned loopback listener"
                        .into(),
                );
            }
            thread::sleep(Duration::from_millis(100));
        };

        let native = parent
            .and_then(|hwnd| {
                platform::NativeHost::attach(hwnd, root_pid, &canonical_executable).ok()
            })
            .unwrap_or_default();
        Ok(Self {
            child,
            root_pid,
            port,
            native,
            port_file,
        })
    }

    pub fn endpoint(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }
    pub fn mode(&self) -> BrowserMode {
        self.native.mode()
    }
    pub fn resize(&mut self, bounds: PhysicalBounds) -> Result<(), String> {
        self.native.resize(bounds)
    }
    pub fn undock(&mut self) -> Result<(), String> {
        self.native.undock()
    }
    pub fn redock(&mut self) -> Result<(), String> {
        self.native.redock()
    }
    pub fn is_running(&mut self) -> bool {
        self.child.try_wait().ok().flatten().is_none()
    }
    pub fn stop(&mut self) {
        let _ = self.native.undock();
        platform::terminate_tree(self.root_pid);
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_file(&self.port_file);
    }
}

fn automation_arguments(profile: &Path) -> Vec<OsString> {
    vec![
        OsString::from(format!("--user-data-dir={}", profile.display())),
        OsString::from("--app=https://chatgpt.com/"),
        OsString::from("--remote-debugging-port=0"),
    ]
}

fn read_devtools_port(path: &Path) -> Result<u16, String> {
    let metadata = fs::metadata(path).map_err(|_| "browser control state is not ready")?;
    if metadata.len() == 0 || metadata.len() > PORT_FILE_LIMIT {
        return Err("browser control state has an invalid size".into());
    }
    let file = fs::File::open(path).map_err(|_| "browser control state is not readable")?;
    let mut data = String::new();
    file.take(PORT_FILE_LIMIT + 1)
        .read_to_string(&mut data)
        .map_err(|_| "browser control state is invalid")?;
    let mut lines = data.lines();
    let port = lines
        .next()
        .ok_or("browser control port is missing")?
        .parse::<u16>()
        .map_err(|_| "browser control port is invalid")?;
    if port == 0 {
        return Err("browser control port is invalid".into());
    }
    let path = lines
        .next()
        .ok_or("browser control websocket path is missing")?;
    if !path.starts_with("/devtools/browser/")
        || path.len() > 512
        || path.contains(char::is_whitespace)
    {
        return Err("browser control websocket path is invalid".into());
    }
    Ok(port)
}

#[cfg(windows)]
mod platform;

#[cfg(not(windows))]
mod platform {
    use super::{BrowserMode, PhysicalBounds};
    use std::path::Path;
    #[derive(Default)]
    pub struct NativeHost;
    impl NativeHost {
        pub fn attach(_: isize, _: u32, _: &Path) -> Result<Self, String> {
            Err("native browser docking is available only on Windows".into())
        }
        pub fn mode(&self) -> BrowserMode {
            BrowserMode::External
        }
        pub fn resize(&mut self, _: PhysicalBounds) -> Result<(), String> {
            Ok(())
        }
        pub fn undock(&mut self) -> Result<(), String> {
            Ok(())
        }
        pub fn redock(&mut self) -> Result<(), String> {
            Err("native browser docking is available only on Windows".into())
        }
    }
    pub fn verify_listener_owner(_: u16, _: u32, _: &Path) -> bool {
        true
    }
    pub fn terminate_tree(_: u32) {}
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn automation_flags_are_minimal_and_loopback_port_is_dynamic() {
        let args = automation_arguments(Path::new("runtime/browser-profile"))
            .into_iter()
            .map(|v| v.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert_eq!(
            args,
            [
                "--user-data-dir=runtime/browser-profile",
                "--app=https://chatgpt.com/",
                "--remote-debugging-port=0"
            ]
        );
        let joined = args.join(" ").to_ascii_lowercase();
        for forbidden in [
            "remote-debugging-address",
            "disable-web-security",
            "no-sandbox",
            "proxy-server",
            "disable-blink",
        ] {
            assert!(!joined.contains(forbidden));
        }
    }
    #[test]
    fn port_file_parser_is_strict_and_does_not_return_websocket_secret() {
        let dir = std::env::temp_dir().join(format!("tab2api-port-test-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        let file = dir.join("DevToolsActivePort");
        fs::write(&file, "45678\n/devtools/browser/random-id\n").unwrap();
        assert_eq!(read_devtools_port(&file).unwrap(), 45678);
        fs::write(&file, "0\n/devtools/browser/id\n").unwrap();
        assert!(read_devtools_port(&file).is_err());
        fs::write(&file, "123\nws://evil.example/devtools/browser/id\n").unwrap();
        assert!(read_devtools_port(&file).is_err());
        let _ = fs::remove_dir_all(dir);
    }
    #[test]
    fn browser_bounds_are_finite_minimum_sized_and_contained() {
        assert_eq!(
            BrowserBounds {
                x: 10.0,
                y: 20.0,
                width: 300.0,
                height: 200.0
            }
            .physical(1.5, 1000, 800)
            .unwrap(),
            PhysicalBounds {
                x: 15,
                y: 30,
                width: 450,
                height: 300
            }
        );
        assert!(
            BrowserBounds {
                x: -1.0,
                y: 0.0,
                width: 300.0,
                height: 200.0
            }
            .physical(1.0, 1000, 800)
            .is_err()
        );
        assert!(
            BrowserBounds {
                x: 0.0,
                y: 0.0,
                width: f64::NAN,
                height: 200.0
            }
            .physical(1.0, 1000, 800)
            .is_err()
        );
    }
}

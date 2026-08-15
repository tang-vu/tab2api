#![cfg_attr(any(test, not(windows)), allow(dead_code))]

use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

const COMMAND_TIMEOUT: Duration = Duration::from_secs(60);
const INSTALL_TIMEOUT: Duration = Duration::from_secs(180);
const STATUS_OUTPUT_LIMIT: u64 = 16 * 1024;

#[derive(Clone, Debug, Deserialize)]
struct ScriptStatus {
    cloudflared_installed: bool,
    config_ready: bool,
    access_probe_ready: bool,
    task_installed: bool,
    running: bool,
    mode: TunnelMode,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TunnelMode {
    None,
    Access,
    BearerOnly,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct TunnelStatus {
    pub supported: bool,
    pub cloudflared_installed: bool,
    pub config_ready: bool,
    pub access_probe_ready: bool,
    pub task_installed: bool,
    pub running: bool,
    pub mode: TunnelMode,
    pub detail: String,
}

#[derive(Clone, Debug)]
struct TunnelScripts {
    install: PathBuf,
    status: PathBuf,
    remove: PathBuf,
}

pub struct TunnelManager {
    scripts: TunnelScripts,
    runtime_dir: PathBuf,
    working_dir: PathBuf,
    operation: Mutex<()>,
}

impl TunnelManager {
    pub fn new(resource_dir: &Path, app_local_data_dir: &Path) -> Result<Self, String> {
        let project_root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .ok_or("desktop directory has no project parent")?;
        let bundled_scripts = resource_dir.join("scripts/windows");
        let development_scripts = project_root.join("scripts/windows");
        let scripts_dir = if bundled_scripts.is_dir() {
            bundled_scripts
        } else if cfg!(debug_assertions) {
            development_scripts
        } else {
            return Err("bundled desktop tunnel management scripts are missing".into());
        };
        let development_runtime = project_root.join(".tab2api");
        let runtime_dir = if cfg!(debug_assertions) && development_runtime.is_dir() {
            development_runtime
        } else {
            app_local_data_dir.join("runtime")
        };
        std::fs::create_dir_all(&runtime_dir)
            .map_err(|_| "could not prepare the private tunnel runtime directory")?;
        let scripts = TunnelScripts {
            install: scripts_dir.join("install-cloudflare-autostart.ps1"),
            status: scripts_dir.join("status-cloudflare-autostart.ps1"),
            remove: scripts_dir.join("remove-cloudflare-autostart.ps1"),
        };
        if ![&scripts.install, &scripts.status, &scripts.remove]
            .iter()
            .all(|path| path.is_file())
        {
            return Err("desktop tunnel management scripts are missing".into());
        }
        Ok(Self {
            scripts,
            runtime_dir,
            working_dir: app_local_data_dir.to_path_buf(),
            operation: Mutex::new(()),
        })
    }

    fn begin_operation(&self) -> Result<MutexGuard<'_, ()>, String> {
        self.operation
            .try_lock()
            .map_err(|_| "another Cloudflare Tunnel operation is already running".into())
    }

    pub fn status(&self) -> Result<TunnelStatus, String> {
        #[cfg(not(windows))]
        return Ok(unsupported_status());

        #[cfg(windows)]
        {
            let output = run_status_script(&self.scripts.status, &self.runtime_dir)?;
            let status: ScriptStatus = serde_json::from_slice(&output)
                .map_err(|_| "tunnel status returned an invalid response")?;
            Ok(public_status(status))
        }
    }

    pub fn install_cloudflared(&self) -> Result<TunnelStatus, String> {
        #[cfg(not(windows))]
        return Err("Cloudflare Tunnel setup is currently available only on Windows".into());

        #[cfg(windows)]
        {
            let _operation = self.begin_operation()?;
            let args = winget_install_arguments();
            run_bounded_command("winget.exe", &args, INSTALL_TIMEOUT)
                .map_err(|_| "cloudflared installation failed; verify winget and network access")?;
            self.status()
        }
    }

    pub fn enable_access(&self, hostname: &str) -> Result<TunnelStatus, String> {
        self.enable(false, hostname)
    }

    pub fn enable_bearer_only(
        &self,
        hostname: &str,
        accepted: bool,
    ) -> Result<TunnelStatus, String> {
        if !accepted {
            return Err(
                "bearer-only activation requires explicit single-owner risk acceptance".into(),
            );
        }
        self.enable(true, hostname)
    }

    fn enable(&self, bearer_only: bool, hostname: &str) -> Result<TunnelStatus, String> {
        let hostname = validate_tunnel_hostname(hostname)?;
        #[cfg(not(windows))]
        return Err("Cloudflare Tunnel setup is currently available only on Windows".into());

        #[cfg(windows)]
        {
            let _operation = self.begin_operation()?;
            let current = self.status()?;
            if !current.cloudflared_installed {
                return Err("install cloudflared before enabling the tunnel".into());
            }
            if !current.config_ready {
                return Err("the private Cloudflare Tunnel config is missing".into());
            }
            if !bearer_only && !current.access_probe_ready {
                return Err("the private Cloudflare Access probe config is missing".into());
            }
            let args = install_script_arguments(
                &self.scripts.install,
                &self.runtime_dir,
                &self.working_dir,
                &hostname,
                bearer_only,
            );
            run_bounded_command("powershell.exe", &args, COMMAND_TIMEOUT).map_err(|_| {
                if bearer_only {
                    "could not install and start the bearer-only tunnel task"
                } else {
                    "Cloudflare Access verification or tunnel activation failed"
                }
            })?;
            let activated = self.status()?;
            if !activation_matches(&activated, bearer_only) {
                return Err(if bearer_only {
                    "the bearer-only tunnel task did not reach its running state"
                } else {
                    "the Access-protected tunnel task did not reach its running state"
                }
                .into());
            }
            Ok(activated)
        }
    }

    pub fn disable(&self) -> Result<TunnelStatus, String> {
        #[cfg(not(windows))]
        return Err("Cloudflare Tunnel setup is currently available only on Windows".into());

        #[cfg(windows)]
        {
            let _operation = self.begin_operation()?;
            let args = script_arguments(&self.scripts.remove);
            run_bounded_command("powershell.exe", &args, COMMAND_TIMEOUT)
                .map_err(|_| "could not stop and remove the Cloudflare Tunnel task")?;
            self.status()
        }
    }

    pub fn open_setup_folder(&self) -> Result<TunnelStatus, String> {
        #[cfg(not(windows))]
        return Err("Cloudflare Tunnel setup is currently available only on Windows".into());

        #[cfg(windows)]
        {
            Command::new("explorer.exe")
                .arg(&self.runtime_dir)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|_| "could not open the private tunnel setup folder")?;
            self.status()
        }
    }
}

fn activation_matches(status: &TunnelStatus, bearer_only: bool) -> bool {
    status.task_installed
        && status.running
        && status.mode
            == if bearer_only {
                TunnelMode::BearerOnly
            } else {
                TunnelMode::Access
            }
}

fn validate_tunnel_hostname(value: &str) -> Result<String, String> {
    let hostname = value.trim().to_ascii_lowercase();
    if hostname.is_empty() || hostname.len() > 253 || !hostname.is_ascii() {
        return Err("enter a valid dedicated tunnel hostname".into());
    }
    let labels: Vec<&str> = hostname.split('.').collect();
    if labels.len() < 2
        || labels.iter().any(|label| {
            label.is_empty()
                || label.len() > 63
                || label.starts_with('-')
                || label.ends_with('-')
                || !label
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        })
        || !labels
            .last()
            .is_some_and(|label| label.bytes().any(|byte| byte.is_ascii_lowercase()))
    {
        return Err("enter a valid dedicated tunnel hostname".into());
    }
    Ok(hostname)
}

fn public_status(status: ScriptStatus) -> TunnelStatus {
    let detail = if status.running {
        match status.mode {
            TunnelMode::Access => "Cloudflare Tunnel is running with Access protection",
            TunnelMode::BearerOnly => {
                "Cloudflare Tunnel is running in explicit single-owner bearer-only mode"
            }
            TunnelMode::None => "Cloudflare Tunnel task is running with an unknown mode",
        }
    } else if status.task_installed {
        "Cloudflare Tunnel is installed but not running"
    } else if !status.cloudflared_installed {
        "Install cloudflared to enable optional personal remote access"
    } else if !status.config_ready {
        "Private tunnel configuration is required before activation"
    } else {
        "Cloudflare Tunnel is ready to enable"
    };
    TunnelStatus {
        supported: true,
        cloudflared_installed: status.cloudflared_installed,
        config_ready: status.config_ready,
        access_probe_ready: status.access_probe_ready,
        task_installed: status.task_installed,
        running: status.running,
        mode: status.mode,
        detail: detail.into(),
    }
}

#[cfg(not(windows))]
fn unsupported_status() -> TunnelStatus {
    TunnelStatus {
        supported: false,
        cloudflared_installed: false,
        config_ready: false,
        access_probe_ready: false,
        task_installed: false,
        running: false,
        mode: TunnelMode::None,
        detail: "Cloudflare Tunnel setup is currently available only on Windows".into(),
    }
}

fn script_arguments(script: &Path) -> Vec<String> {
    vec![
        "-NoProfile".into(),
        "-NonInteractive".into(),
        "-ExecutionPolicy".into(),
        "Bypass".into(),
        "-File".into(),
        script.to_string_lossy().into_owned(),
    ]
}

fn install_script_arguments(
    script: &Path,
    runtime_dir: &Path,
    working_dir: &Path,
    hostname: &str,
    bearer_only: bool,
) -> Vec<String> {
    let mut args = script_arguments(script);
    args.extend([
        "-RuntimeDirectory".into(),
        runtime_dir.to_string_lossy().into_owned(),
        "-WorkingDirectory".into(),
        working_dir.to_string_lossy().into_owned(),
        "-Hostname".into(),
        hostname.into(),
    ]);
    if bearer_only {
        args.push("-AllowBearerOnly".into());
    }
    args
}

fn winget_install_arguments() -> Vec<String> {
    [
        "install",
        "--id",
        "Cloudflare.cloudflared",
        "--exact",
        "--silent",
        "--disable-interactivity",
        "--accept-package-agreements",
        "--accept-source-agreements",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect()
}

#[cfg(windows)]
fn run_status_script(script: &Path, runtime_dir: &Path) -> Result<Vec<u8>, String> {
    let mut args = script_arguments(script);
    args.extend([
        "-RuntimeDirectory".into(),
        runtime_dir.to_string_lossy().into_owned(),
    ]);
    let mut child = Command::new("powershell.exe")
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "could not start the tunnel status check")?;
    wait_for_child(&mut child, COMMAND_TIMEOUT, "tunnel status check")?;
    let mut output = Vec::new();
    child
        .stdout
        .take()
        .ok_or("tunnel status output was unavailable")?
        .take(STATUS_OUTPUT_LIMIT + 1)
        .read_to_end(&mut output)
        .map_err(|_| "could not read tunnel status")?;
    if output.len() as u64 > STATUS_OUTPUT_LIMIT {
        return Err("tunnel status output exceeded its safety limit".into());
    }
    Ok(output)
}

#[cfg(windows)]
fn run_bounded_command(program: &str, args: &[String], timeout: Duration) -> Result<(), String> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "could not start the requested tunnel operation")?;
    wait_for_child(&mut child, timeout, "tunnel operation")
}

#[cfg(windows)]
fn wait_for_child(
    child: &mut std::process::Child,
    timeout: Duration,
    operation: &str,
) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|_| format!("could not inspect {operation}"))?
        {
            return status
                .success()
                .then_some(())
                .ok_or_else(|| format!("{operation} failed"));
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("{operation} timed out"));
        }
        thread::sleep(Duration::from_millis(100));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bearer_only_is_an_explicit_separate_script_flag() {
        let normal = install_script_arguments(
            Path::new("install.ps1"),
            Path::new("runtime"),
            Path::new("work"),
            "tab2api.example.com",
            false,
        );
        let bearer = install_script_arguments(
            Path::new("install.ps1"),
            Path::new("runtime"),
            Path::new("work"),
            "tab2api.example.com",
            true,
        );
        assert!(!normal.iter().any(|value| value == "-AllowBearerOnly"));
        assert!(bearer.iter().any(|value| value == "-AllowBearerOnly"));
        assert!(
            normal
                .windows(2)
                .any(|pair| pair == ["-Hostname", "tab2api.example.com"])
        );
    }

    #[test]
    fn bearer_only_rejects_missing_risk_acceptance_before_running_a_script() {
        let manager = TunnelManager {
            scripts: TunnelScripts {
                install: PathBuf::from("missing-install.ps1"),
                status: PathBuf::from("missing-status.ps1"),
                remove: PathBuf::from("missing-remove.ps1"),
            },
            runtime_dir: PathBuf::from("missing-runtime"),
            working_dir: PathBuf::from("missing-work"),
            operation: Mutex::new(()),
        };
        assert_eq!(
            manager
                .enable_bearer_only("tab2api.example.com", false)
                .unwrap_err(),
            "bearer-only activation requires explicit single-owner risk acceptance"
        );
    }

    #[test]
    fn concurrent_tunnel_mutations_fail_fast_instead_of_blocking_the_app() {
        let manager = TunnelManager {
            scripts: TunnelScripts {
                install: PathBuf::from("missing-install.ps1"),
                status: PathBuf::from("missing-status.ps1"),
                remove: PathBuf::from("missing-remove.ps1"),
            },
            runtime_dir: PathBuf::from("missing-runtime"),
            working_dir: PathBuf::from("missing-work"),
            operation: Mutex::new(()),
        };
        let _operation = manager.begin_operation().unwrap();
        assert_eq!(
            manager.begin_operation().unwrap_err(),
            "another Cloudflare Tunnel operation is already running"
        );
    }

    #[test]
    fn tunnel_hostname_is_normalized_and_rejects_unsafe_values() {
        assert_eq!(
            validate_tunnel_hostname(" Tab2Api.Example.com ").unwrap(),
            "tab2api.example.com"
        );
        for value in [
            "",
            "localhost",
            "127.0.0.1",
            "https://tab2api.example.com",
            "tab2api.example.com/path",
            "-tab2api.example.com",
            "tab2api..example.com",
        ] {
            assert!(validate_tunnel_hostname(value).is_err(), "accepted {value}");
        }
    }

    #[test]
    fn access_probe_uses_only_the_operator_supplied_hostname() {
        let script = include_str!("../../scripts/windows/install-cloudflare-autostart.ps1");
        assert!(script.contains("[string]$Hostname"));
        assert!(script.contains("https://$hostname/healthz"));
        assert!(!script.contains("-Uri 'https://"));
    }

    #[test]
    fn task_transitions_are_bounded_and_bearer_mode_does_not_require_an_access_probe() {
        let install = include_str!("../../scripts/windows/install-cloudflare-autostart.ps1");
        let remove = include_str!("../../scripts/windows/remove-cloudflare-autostart.ps1");
        assert!(install.contains("-not $AllowBearerOnly -and -not (Test-Path"));
        assert!(install.contains("did not reach Running within 10 seconds"));
        assert!(install.contains("previous Cloudflare Tunnel task did not stop within 10 seconds"));
        assert!(remove.contains("did not stop within 10 seconds"));
        assert!(remove.contains("was not removed within 10 seconds"));
        assert!(!install.contains("permit exactly one bounded retry"));
    }

    #[test]
    fn cloudflared_install_is_pinned_to_the_exact_winget_package() {
        assert_eq!(
            winget_install_arguments(),
            [
                "install",
                "--id",
                "Cloudflare.cloudflared",
                "--exact",
                "--silent",
                "--disable-interactivity",
                "--accept-package-agreements",
                "--accept-source-agreements"
            ]
        );
    }

    #[test]
    fn status_messages_do_not_contain_runtime_paths() {
        let status = public_status(ScriptStatus {
            cloudflared_installed: true,
            config_ready: true,
            access_probe_ready: true,
            task_installed: true,
            running: true,
            mode: TunnelMode::Access,
        });
        assert_eq!(
            status.detail,
            "Cloudflare Tunnel is running with Access protection"
        );
        assert!(!status.detail.contains('\\'));
    }

    #[test]
    fn activation_requires_a_running_task_in_the_requested_mode() {
        let mut status = public_status(ScriptStatus {
            cloudflared_installed: true,
            config_ready: true,
            access_probe_ready: true,
            task_installed: true,
            running: true,
            mode: TunnelMode::BearerOnly,
        });
        assert!(activation_matches(&status, true));
        assert!(!activation_matches(&status, false));
        status.running = false;
        assert!(!activation_matches(&status, true));
    }

    #[cfg(windows)]
    #[test]
    fn tunnel_child_timeout_terminates_the_process() {
        let mut child = Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Sleep -Seconds 5",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        assert_eq!(
            wait_for_child(&mut child, Duration::from_millis(20), "test operation").unwrap_err(),
            "test operation timed out"
        );
        assert!(child.try_wait().unwrap().is_some());
    }
}

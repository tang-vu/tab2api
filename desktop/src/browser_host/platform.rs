use super::{BrowserMode, PhysicalBounds};
use std::collections::HashSet;
use std::ffi::c_void;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, HWND, LPARAM, SetLastError};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::Threading::{
    OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
};
use windows_sys::Win32::UI::HiDpi::{AreDpiAwarenessContextsEqual, GetWindowDpiAwarenessContext};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GWL_STYLE, GetClassNameW, GetWindowLongPtrW, GetWindowThreadProcessId,
    IsWindowVisible, SW_RESTORE, SWP_ASYNCWINDOWPOS, SWP_FRAMECHANGED, SWP_NOACTIVATE,
    SWP_SHOWWINDOW, SetParent, SetWindowLongPtrW, SetWindowPos, ShowWindow, WS_CAPTION, WS_CHILD,
    WS_POPUP, WS_SYSMENU, WS_THICKFRAME,
};

#[cfg(test)]
const USES_INTERMEDIATE_HOST_WINDOW: bool = false;

#[cfg(test)]
fn uses_intermediate_host_window() -> bool {
    USES_INTERMEDIATE_HOST_WINDOW
}

#[derive(Default)]
pub struct NativeHost {
    parent: isize,
    browser: isize,
    original_parent: isize,
    original_style: isize,
    docked: bool,
}

impl NativeHost {
    pub fn attach(parent: isize, root_pid: u32, expected_exe: &Path) -> Result<Self, String> {
        if parent == 0 {
            return Err("application window handle is unavailable".into());
        }
        let deadline = Instant::now() + Duration::from_secs(10);
        let browser = loop {
            let pids = process_tree(root_pid);
            if let Some(hwnd) = find_browser_window(&pids, expected_exe) {
                break hwnd;
            }
            if Instant::now() >= deadline {
                return Err("owned Chromium application window was not found".into());
            }
            thread::sleep(Duration::from_millis(100));
        };
        let dpi_matches = unsafe {
            let parent_dpi = GetWindowDpiAwarenessContext(parent as HWND);
            let browser_dpi = GetWindowDpiAwarenessContext(browser as HWND);
            !parent_dpi.is_null()
                && !browser_dpi.is_null()
                && AreDpiAwarenessContextsEqual(parent_dpi, browser_dpi) != 0
        };
        if !dpi_matches {
            return Err("Chromium and the desktop window use incompatible DPI modes".into());
        }
        let original_style = unsafe { GetWindowLongPtrW(browser as HWND, GWL_STYLE) };
        // Do not create a helper HWND on this spawn_blocking worker. A Win32 window belongs to
        // its creating thread and requires that thread to pump messages; using such a helper as
        // Chromium's parent deadlocks painting and can hang the Tauri window. Chromium already
        // has its own UI message loop, so make it a direct child of the Tauri main HWND instead.
        let original_parent = match unsafe { set_parent_checked(browser as HWND, parent as HWND) } {
            Ok(parent) => parent,
            Err(()) => return Err("Chromium rejected native docking".into()),
        };
        let child_style = (original_style
            & !(WS_POPUP | WS_CAPTION | WS_THICKFRAME | WS_SYSMENU) as isize)
            | WS_CHILD as isize;
        unsafe {
            SetWindowLongPtrW(browser as HWND, GWL_STYLE, child_style);
            ShowWindow(browser as HWND, SW_RESTORE);
            SetWindowPos(
                browser as HWND,
                std::ptr::null_mut(),
                0,
                0,
                1,
                1,
                SWP_ASYNCWINDOWPOS | SWP_FRAMECHANGED | SWP_NOACTIVATE | SWP_SHOWWINDOW,
            );
        }
        Ok(Self {
            parent,
            browser,
            original_parent: original_parent as isize,
            original_style,
            docked: true,
        })
    }

    pub fn mode(&self) -> BrowserMode {
        if self.docked {
            BrowserMode::Docked
        } else {
            BrowserMode::External
        }
    }

    pub fn resize(&mut self, b: PhysicalBounds) -> Result<(), String> {
        if !self.docked {
            return Ok(());
        }
        // HWND_TOP (NULL) keeps Chromium above the WebView sibling. ASYNCWINDOWPOS prevents the
        // caller from waiting on Chromium's cross-thread window procedure during a resize.
        let browser_ok = unsafe {
            SetWindowPos(
                self.browser as HWND,
                std::ptr::null_mut(),
                b.x,
                b.y,
                b.width,
                b.height,
                SWP_ASYNCWINDOWPOS | SWP_NOACTIVATE | SWP_SHOWWINDOW,
            )
        };
        if browser_ok == 0 {
            self.undock()?;
            return Err("native browser resize failed; Chromium was restored externally".into());
        }
        Ok(())
    }

    pub fn undock(&mut self) -> Result<(), String> {
        if !self.docked {
            return Ok(());
        }
        unsafe {
            SetWindowLongPtrW(self.browser as HWND, GWL_STYLE, self.original_style);
            SetParent(self.browser as HWND, self.original_parent as HWND);
            SetWindowPos(
                self.browser as HWND,
                std::ptr::null_mut(),
                80,
                80,
                1000,
                760,
                SWP_ASYNCWINDOWPOS | SWP_FRAMECHANGED | SWP_NOACTIVATE | SWP_SHOWWINDOW,
            );
            ShowWindow(self.browser as HWND, SW_RESTORE);
        }
        self.docked = false;
        Ok(())
    }

    pub fn redock(&mut self) -> Result<(), String> {
        if self.docked {
            return Ok(());
        }
        if self.parent == 0 || self.browser == 0 {
            return Err("native browser host is unavailable".into());
        }
        if unsafe { set_parent_checked(self.browser as HWND, self.parent as HWND) }.is_err() {
            return Err("Chromium rejected native re-docking".into());
        }
        let style = (self.original_style
            & !(WS_POPUP | WS_CAPTION | WS_THICKFRAME | WS_SYSMENU) as isize)
            | WS_CHILD as isize;
        unsafe {
            SetWindowLongPtrW(self.browser as HWND, GWL_STYLE, style);
        }
        self.docked = true;
        Ok(())
    }
}

unsafe fn set_parent_checked(child: HWND, parent: HWND) -> Result<HWND, ()> {
    unsafe { SetLastError(0) };
    let previous = unsafe { SetParent(child, parent) };
    if previous.is_null() && unsafe { GetLastError() } != 0 {
        Err(())
    } else {
        Ok(previous)
    }
}

pub fn terminate_tree(root_pid: u32) {
    let arguments = taskkill_arguments(root_pid);
    let Ok(mut killer) = Command::new("taskkill")
        .args(&arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    else {
        return;
    };
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        if killer.try_wait().ok().flatten().is_some() {
            return;
        }
        thread::sleep(Duration::from_millis(50));
    }
    let _ = killer.kill();
    let _ = killer.wait();
}

fn taskkill_arguments(root_pid: u32) -> [String; 4] {
    [
        "/PID".into(),
        root_pid.to_string(),
        "/T".into(),
        "/F".into(),
    ]
}

impl Drop for NativeHost {
    fn drop(&mut self) {
        let _ = self.undock();
    }
}

pub fn verify_listener_owner(port: u16, root_pid: u32, expected_exe: &Path) -> bool {
    let pids = process_tree(root_pid);
    if !pids
        .iter()
        .any(|pid| process_executable(*pid).is_some_and(|p| same_file(&p, expected_exe)))
    {
        return false;
    }
    let Ok(mut child) = Command::new("netstat")
        .args(["-ano", "-p", "tcp"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        return false;
    };
    let mut data = String::new();
    if let Some(output) = child.stdout.take() {
        let _ = output.take(128 * 1024).read_to_string(&mut data);
    }
    let _ = child.wait();
    parse_netstat_owned_loopback(&data, port, &pids)
}

fn parse_netstat_owned_loopback(text: &str, port: u16, pids: &HashSet<u32>) -> bool {
    let suffix = format!(":{port}");
    let rows = text
        .lines()
        .filter_map(|line| {
            let fields = line.split_whitespace().collect::<Vec<_>>();
            (fields.len() >= 5
                && fields[0].eq_ignore_ascii_case("TCP")
                && fields[1].ends_with(&suffix)
                && fields[3].eq_ignore_ascii_case("LISTENING"))
            .then(|| (fields[1], fields[4].parse::<u32>().ok()))
        })
        .collect::<Vec<_>>();
    !rows.is_empty()
        && rows.iter().all(|(addr, pid)| {
            (*addr == format!("127.0.0.1:{port}") || *addr == format!("[::1]:{port}"))
                && pid.is_some_and(|id| pids.contains(&id))
        })
}

fn process_tree(root: u32) -> HashSet<u32> {
    let mut parents = Vec::new();
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == -1isize as *mut c_void {
            return HashSet::from([root]);
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        if Process32FirstW(snapshot, &mut entry) != 0 {
            loop {
                parents.push((entry.th32ProcessID, entry.th32ParentProcessID));
                if Process32NextW(snapshot, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snapshot);
    }
    let mut result = HashSet::from([root]);
    loop {
        let before = result.len();
        for (pid, parent) in &parents {
            if result.contains(parent) {
                result.insert(*pid);
            }
        }
        if result.len() == before {
            break;
        }
    }
    result
}

struct EnumContext<'a> {
    pids: &'a HashSet<u32>,
    expected: &'a Path,
    found: isize,
}
unsafe extern "system" fn enum_callback(hwnd: HWND, param: LPARAM) -> i32 {
    let context = unsafe { &mut *(param as *mut EnumContext<'_>) };
    if unsafe { IsWindowVisible(hwnd) } == 0 {
        return 1;
    }
    let mut pid = 0;
    unsafe {
        GetWindowThreadProcessId(hwnd, &mut pid);
    }
    if !context.pids.contains(&pid)
        || !process_executable(pid).is_some_and(|p| same_file(&p, context.expected))
    {
        return 1;
    }
    let mut class = [0u16; 128];
    let len = unsafe { GetClassNameW(hwnd, class.as_mut_ptr(), class.len() as i32) };
    if String::from_utf16_lossy(&class[..len.max(0) as usize]) != "Chrome_WidgetWin_1" {
        return 1;
    }
    context.found = hwnd as isize;
    0
}
fn find_browser_window(pids: &HashSet<u32>, expected: &Path) -> Option<isize> {
    let mut context = EnumContext {
        pids,
        expected,
        found: 0,
    };
    unsafe {
        EnumWindows(Some(enum_callback), &mut context as *mut _ as LPARAM);
    }
    (context.found != 0).then_some(context.found)
}
fn process_executable(pid: u32) -> Option<PathBuf> {
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if process.is_null() {
            return None;
        }
        let mut buffer = vec![0u16; 32768];
        let mut len = buffer.len() as u32;
        let ok = QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut len);
        CloseHandle(process);
        (ok != 0).then(|| PathBuf::from(String::from_utf16_lossy(&buffer[..len as usize])))
    }
}
fn same_file(left: &Path, right: &Path) -> bool {
    left.canonicalize()
        .ok()
        .zip(right.canonicalize().ok())
        .is_some_and(|(l, r)| {
            l.to_string_lossy()
                .eq_ignore_ascii_case(&r.to_string_lossy())
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn listener_must_be_owned_and_loopback_only() {
        let pids = HashSet::from([42]);
        assert!(parse_netstat_owned_loopback(
            " TCP 127.0.0.1:49152 0.0.0.0:0 LISTENING 42",
            49152,
            &pids
        ));
        assert!(!parse_netstat_owned_loopback(
            " TCP 0.0.0.0:49152 0.0.0.0:0 LISTENING 42",
            49152,
            &pids
        ));
        assert!(!parse_netstat_owned_loopback(
            " TCP 127.0.0.1:49152 0.0.0.0:0 LISTENING 99",
            49152,
            &pids
        ));
    }

    #[test]
    fn cleanup_targets_only_the_launched_pid_and_descendants() {
        assert_eq!(taskkill_arguments(4242), ["/PID", "4242", "/T", "/F"]);
    }

    #[test]
    fn docking_does_not_create_a_worker_owned_host_window() {
        assert!(!uses_intermediate_host_window());
    }
}

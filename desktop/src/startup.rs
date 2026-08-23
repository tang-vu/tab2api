#![cfg_attr(test, allow(dead_code))]

use serde::Serialize;
use std::ffi::{OsStr, OsString};
use std::sync::Mutex;

pub const AUTOSTART_ARG: &str = "--tab2api-autostart";
pub const AUTOSTART_ENTRY_NAME: &str = "tab2api";
const BUSY_ERROR: &str = "another sign-in launch change is already running";
const INSPECT_ERROR: &str = "could not inspect the operating-system sign-in launch setting";
const UPDATE_ERROR: &str = "could not update the operating-system sign-in launch setting";
const VERIFY_ERROR: &str =
    "the operating-system sign-in launch setting did not reach the requested state";

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub struct AutostartStatus {
    pub enabled: bool,
}

#[derive(Default)]
pub struct StartupManager {
    mutation: Mutex<()>,
}

impl StartupManager {
    pub fn status(
        &self,
        inspect: impl FnOnce() -> Result<bool, ()>,
    ) -> Result<AutostartStatus, String> {
        let _guard = self
            .mutation
            .try_lock()
            .map_err(|_| BUSY_ERROR.to_string())?;
        inspect()
            .map(|enabled| AutostartStatus { enabled })
            .map_err(|()| INSPECT_ERROR.to_string())
    }

    pub fn set(
        &self,
        enabled: bool,
        update: impl FnOnce() -> Result<(), ()>,
        inspect: impl FnOnce() -> Result<bool, ()>,
    ) -> Result<AutostartStatus, String> {
        let _guard = self
            .mutation
            .try_lock()
            .map_err(|_| BUSY_ERROR.to_string())?;
        update().map_err(|()| UPDATE_ERROR.to_string())?;
        let actual = inspect().map_err(|()| INSPECT_ERROR.to_string())?;
        if actual != enabled {
            return Err(VERIFY_ERROR.to_string());
        }
        Ok(AutostartStatus { enabled: actual })
    }
}

pub fn launched_from_autostart(args: impl IntoIterator<Item = OsString>) -> bool {
    args.into_iter()
        .any(|argument| argument == OsStr::new(AUTOSTART_ARG))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn autostart_argument_requires_an_exact_dedicated_flag() {
        assert!(launched_from_autostart([
            OsString::from("tab2api-desktop"),
            OsString::from(AUTOSTART_ARG),
        ]));
        assert!(!launched_from_autostart([
            OsString::from("tab2api-desktop"),
            OsString::from("--tab2api-autostart-extra"),
        ]));
    }

    #[test]
    fn status_returns_only_the_boolean_registration_state() {
        let manager = StartupManager::default();
        assert_eq!(
            manager.status(|| Ok(true)),
            Ok(AutostartStatus { enabled: true })
        );
        assert_eq!(manager.status(|| Err(())), Err(INSPECT_ERROR.to_string()));
    }

    #[test]
    fn updates_are_verified_before_success_is_reported() {
        let manager = StartupManager::default();
        let enabled = Cell::new(false);
        let status = manager
            .set(
                true,
                || {
                    enabled.set(true);
                    Ok(())
                },
                || Ok(enabled.get()),
            )
            .expect("enable should be verified");
        assert!(status.enabled);

        assert_eq!(
            manager.set(false, || Ok(()), || Ok(true)),
            Err(VERIFY_ERROR.to_string())
        );
    }

    #[test]
    fn backend_failures_are_typed_and_do_not_cross_the_native_boundary() {
        let manager = StartupManager::default();
        assert_eq!(
            manager.set(true, || Err(()), || Ok(false)),
            Err(UPDATE_ERROR.to_string())
        );
        assert_eq!(
            manager.set(true, || Ok(()), || Err(())),
            Err(INSPECT_ERROR.to_string())
        );
    }

    #[test]
    fn concurrent_mutations_fail_fast() {
        let manager = StartupManager::default();
        let guard = manager.mutation.lock().expect("test mutex should lock");
        assert_eq!(manager.status(|| Ok(false)), Err(BUSY_ERROR.to_string()));
        assert_eq!(
            manager.set(true, || Ok(()), || Ok(true)),
            Err(BUSY_ERROR.to_string())
        );
        drop(guard);
    }
}

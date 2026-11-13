//! Android Keystore-backed secret storage for the mobile shell.
//!
//! The WebDAV password is the only secret this crate handles. Values are
//! encrypted with an AES-256-GCM key that never leaves Android Keystore and
//! stored in the app's private SharedPreferences. The ledger database is not
//! involved, and the password is never exposed to the web view.

#[cfg(target_os = "android")]
use serde::{Deserialize, Serialize};
#[cfg(target_os = "android")]
use tauri::plugin::PluginHandle;
use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

const PLUGIN_NAME: &str = "secure-store";

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "app.wheeltracker.securestore";

#[cfg(target_os = "android")]
#[derive(Serialize)]
struct SaveArgs<'a> {
    key: &'a str,
    value: &'a str,
}

#[cfg(target_os = "android")]
#[derive(Serialize)]
struct KeyArgs<'a> {
    key: &'a str,
}

#[cfg(target_os = "android")]
#[derive(Deserialize)]
struct LoadResponse {
    value: String,
}

/// Handle to the platform secret store.
///
/// Android uses the Kotlin plugin; other targets keep the type so the mobile
/// shell still compiles and tests on a desktop host, but every operation
/// returns an error.
pub struct SecureStore<R: Runtime> {
    #[cfg(target_os = "android")]
    handle: PluginHandle<R>,
    #[cfg(not(target_os = "android"))]
    _marker: std::marker::PhantomData<fn() -> R>,
}

impl<R: Runtime> SecureStore<R> {
    /// Encrypts `value` and stores it under `key`, replacing any previous value.
    pub fn save(&self, key: &str, value: &str) -> Result<(), String> {
        #[cfg(target_os = "android")]
        {
            self.handle
                .run_mobile_plugin::<()>("save", SaveArgs { key, value })
                .map_err(|error| error.to_string())
        }
        #[cfg(not(target_os = "android"))]
        {
            let _ = (key, value);
            Err("secure storage is only available on Android".into())
        }
    }

    /// Returns the decrypted value, or `None` when nothing is stored.
    pub fn load(&self, key: &str) -> Result<Option<String>, String> {
        #[cfg(target_os = "android")]
        {
            let response: LoadResponse = self
                .handle
                .run_mobile_plugin("load", KeyArgs { key })
                .map_err(|error| error.to_string())?;
            Ok((!response.value.is_empty()).then_some(response.value))
        }
        #[cfg(not(target_os = "android"))]
        {
            let _ = key;
            Err("secure storage is only available on Android".into())
        }
    }

    /// Removes the value under `key`; a missing key is not an error.
    pub fn delete(&self, key: &str) -> Result<(), String> {
        #[cfg(target_os = "android")]
        {
            self.handle
                .run_mobile_plugin::<()>("delete", KeyArgs { key })
                .map_err(|error| error.to_string())
        }
        #[cfg(not(target_os = "android"))]
        {
            let _ = key;
            Err("secure storage is only available on Android".into())
        }
    }
}

/// Access the secret store from an app handle.
pub trait SecureStoreExt<R: Runtime> {
    fn secure_store(&self) -> &SecureStore<R>;
}

impl<R: Runtime, T: Manager<R>> SecureStoreExt<R> for T {
    fn secure_store(&self) -> &SecureStore<R> {
        self.state::<SecureStore<R>>().inner()
    }
}

/// Initializes the plugin. Must be registered before the mobile shell's setup.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new(PLUGIN_NAME)
        .setup(|app, api| {
            #[cfg(not(target_os = "android"))]
            let _ = api;
            #[cfg(target_os = "android")]
            let store = SecureStore {
                handle: api.register_android_plugin(PLUGIN_IDENTIFIER, "SecureStorePlugin")?,
            };
            #[cfg(not(target_os = "android"))]
            let store: SecureStore<R> = SecureStore {
                _marker: std::marker::PhantomData,
            };
            app.manage(store);
            Ok(())
        })
        .build()
}

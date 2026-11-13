fn main() {
    tauri_plugin::Builder::new(&["save", "load", "delete"])
        .android_path("android")
        .try_build()
        .expect("failed to build the secure-store plugin");
}

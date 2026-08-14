fn main() {
    // The app icon is compiled in as a Windows resource by `tauri_build`, but
    // cargo only reruns this script when an input it was told about changes —
    // and the icon directory is not one of them. Without this, replacing an
    // icon rebuilds the crate and silently keeps the old one embedded, in both
    // dev and release, until something else forces the script to rerun.
    println!("cargo:rerun-if-changed=icons");

    tauri_build::build()
}

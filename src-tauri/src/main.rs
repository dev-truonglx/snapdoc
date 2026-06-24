// Ẩn console window trên Windows ở bản release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    snapdoc_lib::run();
}

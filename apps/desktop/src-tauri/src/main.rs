// Prevent an extra console window on Windows in release; no effect on macOS/Linux.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    pr_visualizer_lib::run()
}

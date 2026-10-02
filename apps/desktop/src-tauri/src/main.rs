// Prevent an extra console window on Windows in release; no effect on macOS/Linux.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args().nth(1).as_deref() == Some("--render-mcp") {
        if let Err(error) = pr_visualizer_lib::run_render_mcp() {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }
    pr_visualizer_lib::run()
}

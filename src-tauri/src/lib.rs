mod debug;
mod dotnet;
mod fs;
mod proc;
mod pty;
mod search;
mod watch;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(watch::WatchState::default())
        .manage(pty::PtyState::default())
        .manage(proc::ProcState::default())
        .invoke_handler(tauri::generate_handler![
            fs::list_dir,
            fs::read_text_file,
            fs::write_text_file,
            fs::create_file,
            fs::create_dir,
            fs::rename_path,
            fs::delete_path,
            fs::config_dir,
            fs::startup_folder,
            watch::watch_folder,
            search::list_files,
            search::search_text,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            proc::lsp_start,
            proc::lsp_send,
            proc::proc_start,
            proc::proc_kill,
            dotnet::dotnet_info,
            dotnet::find_dotnet_workspace,
            dotnet::read_solution,
            dotnet::read_project,
            debug::find_debugger,
            debug::install_netcoredbg,
            debug::run_capture,
            debug::list_processes,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

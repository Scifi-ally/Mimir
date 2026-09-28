use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{Emitter, Manager, RunEvent};

const BACKEND_PORT: u16 = 5000;
const AI_PORT: u16 = 8001;
const SERVICE_WAIT_TIMEOUT: Duration = Duration::from_secs(90);

/// Snapshot of every managed service, surfaced to the UI.
#[derive(Serialize, Clone, Debug)]
pub struct ServiceStatus {
    pub backend: bool,
    pub ai: bool,
    pub project_root: Option<String>,
    pub managed: bool,
}

#[derive(Serialize, Clone)]
struct ServiceEvent {
    status: ServiceStatus,
}

/// Handles for services this app started, so they can be stopped on exit.
///
/// Only services WE spawned are tracked. A backend the user already had running
/// is left completely alone — killing someone else's process on exit would be
/// hostile, and double-starting would fight it for the port.
#[derive(Default)]
struct ManagedServices {
    children: Mutex<Vec<Child>>,
}

impl ManagedServices {
    fn adopt(&self, child: Child) {
        if let Ok(mut v) = self.children.lock() {
            v.push(child);
        }
    }

    fn shutdown(&self) {
        if let Ok(mut v) = self.children.lock() {
            for child in v.iter_mut() {
                // Best effort: a service that already exited needs no action.
                let _ = child.kill();
                let _ = child.wait();
            }
            v.clear();
        }
    }

    fn count(&self) -> usize {
        self.children.lock().map(|v| v.len()).unwrap_or(0)
    }
}

fn port_is_open(port: u16) -> bool {
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    TcpStream::connect_timeout(&addr, Duration::from_millis(600)).is_ok()
}

fn wait_for_port(port: u16, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if port_is_open(port) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(400));
    }
    false
}

/// Locate the Mimir project root.
///
/// A bundled app cannot assume any particular working directory, so resolution
/// is explicit and ordered: `MIMIR_DIR` first (matching the `bin/mimir.ps1`
/// launcher), then an upward search from both the current directory and the
/// executable's directory for a tree that contains `backend/package.json`.
fn find_project_root() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Ok(dir) = std::env::var("MIMIR_DIR") {
        if !dir.is_empty() {
            candidates.push(PathBuf::from(dir));
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.to_path_buf());
        }
    }

    for start in candidates {
        let mut cur: Option<&Path> = Some(start.as_path());
        let mut hops = 0;
        while let Some(dir) = cur {
            if dir.join("backend").join("package.json").is_file() {
                return Some(dir.to_path_buf());
            }
            hops += 1;
            if hops > 6 {
                break;
            }
            cur = dir.parent();
        }
    }
    None
}

fn python_executable(root: &Path) -> String {
    // Prefer the project virtualenv so the installed model dependencies are used.
    for candidate in [
        root.join(".venv").join("Scripts").join("python.exe"),
        root.join(".venv").join("bin").join("python"),
    ] {
        if candidate.is_file() {
            return candidate.to_string_lossy().to_string();
        }
    }
    "python".to_string()
}

fn spawn_hidden(command: &mut Command) -> std::io::Result<Child> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // DETACHED_PROCESS | CREATE_NO_WINDOW: no console flash behind the app.
        command.creation_flags(0x0000_0008 | 0x0800_0000);
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
}

#[tauri::command]
fn service_status(managed: tauri::State<'_, ManagedServices>) -> ServiceStatus {
    ServiceStatus {
        backend: port_is_open(BACKEND_PORT),
        ai: port_is_open(AI_PORT),
        project_root: find_project_root().map(|p| p.to_string_lossy().to_string()),
        managed: managed.count() > 0,
    }
}

#[tauri::command]
fn shutdown_services(managed: tauri::State<'_, ManagedServices>) {
    managed.shutdown();
}

fn build_status() -> ServiceStatus {
    ServiceStatus {
        backend: port_is_open(BACKEND_PORT),
        ai: port_is_open(AI_PORT),
        project_root: find_project_root().map(|p| p.to_string_lossy().to_string()),
        managed: false,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(ManagedServices::default())
        .invoke_handler(tauri::generate_handler![service_status, shutdown_services])
        .setup(|app| {
            let handle = app.handle().clone();
            let managed = app.state::<ManagedServices>();

            // Bring the backend and AI service up so a single app launch is
            // self-contained. Both are skipped if already listening, so this is
            // safe to run alongside `mimir start` or a dev session.
            let root = find_project_root();

            if let Some(root) = root.as_ref() {
                if !port_is_open(BACKEND_PORT) {
                    let backend_dir = root.join("backend");
                    if backend_dir.join("package.json").is_file() {
                        let mut cmd = if cfg!(windows) {
                            let mut c = Command::new("cmd.exe");
                            c.args(["/c", "npm", "run", "dev"]);
                            c
                        } else {
                            let mut c = Command::new("npm");
                            c.args(["run", "dev"]);
                            c
                        };
                        cmd.current_dir(&backend_dir);
                        if let Ok(child) = spawn_hidden(&mut cmd) {
                            managed.adopt(child);
                        }
                    }
                }

                if !port_is_open(AI_PORT) {
                    let ai_dir = root.join("backend").join("ai_service");
                    if ai_dir.join("main.py").is_file() {
                        let mut cmd = Command::new(python_executable(root));
                        cmd.arg("-m")
                            .arg("uvicorn")
                            .arg("main:app")
                            .arg("--app-dir")
                            .arg(&ai_dir)
                            .arg("--host")
                            .arg("127.0.0.1")
                            .arg("--port")
                            .arg(AI_PORT.to_string());
                        cmd.current_dir(&ai_dir);
                        if let Ok(child) = spawn_hidden(&mut cmd) {
                            managed.adopt(child);
                        }
                    }
                }
            }

            if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_title("Mimir Trading Dashboard");
            }

            // Wait for readiness off the UI thread and report progress back, so
            // the window paints immediately instead of blocking on the model
            // load (first run pulls FinBERT + Chronos and takes ~1 minute).
            std::thread::spawn(move || {
                let _ = wait_for_port(BACKEND_PORT, SERVICE_WAIT_TIMEOUT);
                let _ = wait_for_port(AI_PORT, SERVICE_WAIT_TIMEOUT);
                let _ = handle.emit("mimir://service-status", ServiceEvent { status: build_status() });
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Stop only the services this app started.
            if let RunEvent::Exit = event {
                if let Some(managed) = app.try_state::<ManagedServices>() {
                    managed.shutdown();
                }
            }
        });
}

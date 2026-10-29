//! Entry point: reads PORT, DB_PATH, ADMIN_KEY and CLIENT_KEY from the environment. A missing key stops the
//! process at start-up instead of at the first request.

use std::collections::HashMap;
use std::process::ExitCode;

use ffservice::config::Config;
use ffservice::handler;
use ffservice::repository::SqliteRepository;
use ffservice::service::Service;

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut s) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            s.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        () = ctrl_c => {},
        () = terminate => {},
    }
}

async fn run() -> Result<(), String> {
    let env: HashMap<String, String> = std::env::vars().collect();
    let config = Config::load(&env)?;
    let repo = SqliteRepository::open(&config.db_path)
        .map_err(|e| format!("cannot open database {}: {e:?}", config.db_path))?;
    let app = handler::router(Service::new(repo), &config.admin_key, &config.client_key)?;
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", config.port))
        .await
        .map_err(|e| format!("cannot listen on port {}: {e}", config.port))?;
    println!("listening on {}", listener.local_addr().map_err(|e| e.to_string())?);
    axum::serve(listener, app).with_graceful_shutdown(shutdown_signal()).await.map_err(|e| e.to_string())
}

#[tokio::main]
async fn main() -> ExitCode {
    match run().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("error: {message}");
            ExitCode::FAILURE
        }
    }
}

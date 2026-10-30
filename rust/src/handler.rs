//! HTTP: routing, authentication, JSON in and out, and the mapping from service errors to status codes. It holds
//! no business rules.
//!
//! axum matches routes on the raw path, so `/v1/flags/a%2Fb` is one segment and `;` means nothing. What it does not
//! do is leave a decoded value alone: its `Path` extractor answers 400 for `%FF`. So the key is cut from the raw URI
//! here and decoded by hand (BR-55).

use std::collections::HashMap;
use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, StatusCode, Uri, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use http_body_util::BodyExt;
use serde_json::{Value, json};

use crate::error::{Code, ServiceError};
use crate::parse;
use crate::repository::Repository;
use crate::service::{Error, Service};
use crate::timefmt::format_time;

pub const MAX_BODY_BYTES: usize = 1 << 20;

// ---------------------------------------------------------------- responses

fn json_response(status: u16, body: &Value) -> Response {
    let status = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    (status, [(header::CONTENT_TYPE, "application/json")], body.to_string()).into_response()
}

fn error_response(code: Code, message: &str) -> Response {
    json_response(code.status(), &json!({"error": {"code": code.as_str(), "message": message}}))
}

/// What a handler can fail with: a client error to report, or an internal failure to hide.
pub struct ApiError(Error);

impl From<Error> for ApiError {
    fn from(e: Error) -> Self {
        ApiError(e)
    }
}

impl From<ServiceError> for ApiError {
    fn from(e: ServiceError) -> Self {
        ApiError(Error::Client(e))
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        match self.0 {
            Error::Client(e) => error_response(e.code, &e.message),
            Error::Storage(detail) => {
                eprintln!("internal error: {detail}");
                error_response(Code::Internal, "internal error") // no details for the client
            }
        }
    }
}

type Handled = Result<Response, ApiError>;

// ---------------------------------------------------------------------- auth

/// What a request is allowed to do (BR-10..12).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Level {
    None,
    Client,
    Admin,
}

/// Equal in time that depends on the longer length only, not on where the first difference is.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    let mut diff = a.len() ^ b.len();
    for i in 0..a.len().max(b.len()) {
        diff |= usize::from(a.get(i).copied().unwrap_or(0) ^ b.get(i).copied().unwrap_or(0));
    }
    diff == 0
}

pub struct App<R: Repository> {
    service: Service<R>,
    admin_key: Vec<u8>,
    client_key: Vec<u8>,
}

impl<R: Repository> App<R> {
    /// A key header holds bytes, not text: any value at all, however odd, is just a wrong key.
    fn level(&self, headers: &HeaderMap) -> Level {
        let value = |name: &str| headers.get(name).map_or(&b""[..], |v| v.as_bytes());
        if constant_time_eq(value("x-admin-key"), &self.admin_key) {
            Level::Admin
        } else if constant_time_eq(value("x-client-key"), &self.client_key) {
            Level::Client
        } else {
            Level::None
        }
    }

    fn require_admin(&self, headers: &HeaderMap) -> Result<(), ApiError> {
        match self.level(headers) {
            Level::Admin => Ok(()),
            Level::Client => Err(ServiceError::new(Code::Forbidden, "this key cannot use the admin API").into()),
            Level::None => Err(ServiceError::new(Code::Unauthorized, "missing or invalid admin key").into()),
        }
    }

    fn require_client_or_admin(&self, headers: &HeaderMap) -> Result<(), ApiError> {
        if self.level(headers) == Level::None {
            return Err(ServiceError::new(Code::Unauthorized, "missing or invalid key").into());
        }
        Ok(())
    }
}

// ------------------------------------------------------------------ raw paths

/// Decode %XX escapes as UTF-8. Bytes that are not valid UTF-8 become U+FFFD: no flag has such a key, so a path like
/// /v1/flags/%FF is "not found", not an error (BR-55). The text must contain no broken escape.
fn percent_decode(raw: &str, plus_is_space: bool) -> String {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok());
                out.push(hex.unwrap_or(b'%'));
                i += if hex.is_some() { 3 } else { 1 };
            }
            b'+' if plus_is_space => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// True if `%` is not followed by two hex digits anywhere in `s`.
fn has_broken_escape(s: &str) -> bool {
    let b = s.as_bytes();
    (0..b.len())
        .any(|i| b[i] == b'%' && !(i + 2 < b.len() && b[i + 1].is_ascii_hexdigit() && b[i + 2].is_ascii_hexdigit()))
}

/// Split a query string like Go's net/url: '&' separates pairs, '+' is a space, a pair with a bad escape or a ';' is
/// dropped, and a repeated name keeps all its values in order (the first one counts, BR-50).
fn parse_query(raw: Option<&str>) -> HashMap<String, Vec<String>> {
    let mut out: HashMap<String, Vec<String>> = HashMap::new();
    for pair in raw.unwrap_or("").split('&') {
        if pair.is_empty() || pair.contains(';') || has_broken_escape(pair) {
            continue;
        }
        let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
        out.entry(percent_decode(name, true)).or_default().push(percent_decode(value, true));
    }
    out
}

/// The `{key}` of /v1/flags/{key} and /v1/flags/{key}/results, from the raw path.
fn path_key(uri: &Uri) -> String {
    let rest = uri.path().strip_prefix("/v1/flags/").unwrap_or("");
    percent_decode(rest.split('/').next().unwrap_or(""), false)
}

// ----------------------------------------------------------------------- body

/// Read the whole body (even an oversized one: answering while the client is still uploading resets the connection)
/// and parse it as one strict JSON value (BR-52).
async fn read_json(body: Body) -> Result<Value, ApiError> {
    let mut body = body;
    let mut data: Vec<u8> = Vec::new();
    let mut size = 0usize;
    while let Some(frame) = body.frame().await {
        let Ok(frame) = frame else {
            return Err(ServiceError::validation("request body could not be read").into());
        };
        if let Some(chunk) = frame.data_ref() {
            size += chunk.len();
            if size <= MAX_BODY_BYTES {
                data.extend_from_slice(chunk);
            }
        }
    }
    if size > MAX_BODY_BYTES {
        return Err(ServiceError::validation("request body is larger than 1 MiB").into());
    }
    // Strict UTF-8 first: invalid bytes (and a CESU-8 surrogate) are errors, never U+FFFD. serde_json then rejects a
    // BOM, NaN, leading zeros, comments, trailing commas, a lone surrogate escape, anything after the first value and
    // nesting deeper than 128.
    let text = std::str::from_utf8(&data).map_err(|_| ServiceError::validation("request body must be valid UTF-8"))?;
    serde_json::from_str(text).map_err(|_| ServiceError::validation("request body must be valid JSON").into())
}

// ------------------------------------------------------------------- endpoints

type Shared<R> = State<Arc<App<R>>>;

async fn healthz() -> Response {
    json_response(200, &json!({"status": "ok"}))
}

async fn list_flags<R: Repository + 'static>(State(app): Shared<R>, req: Request) -> Handled {
    app.require_admin(req.headers())?;
    let page = parse::page(&parse_query(req.uri().query()))?;
    let (flags, total) = app.service.list_flags(page)?;
    Ok(json_response(
        200,
        &json!({"items": flags.iter().map(crate::model::Flag::to_json).collect::<Vec<_>>(), "total": total}),
    ))
}

async fn create_flag<R: Repository + 'static>(State(app): Shared<R>, req: Request) -> Handled {
    app.require_admin(req.headers())?;
    let body = read_json(req.into_body()).await?;
    Ok(json_response(201, &app.service.create_flag(&body)?.to_json()))
}

async fn get_flag<R: Repository + 'static>(State(app): Shared<R>, req: Request) -> Handled {
    app.require_admin(req.headers())?;
    Ok(json_response(200, &app.service.get_flag(&path_key(req.uri()))?.to_json()))
}

async fn update_flag<R: Repository + 'static>(State(app): Shared<R>, req: Request) -> Handled {
    app.require_admin(req.headers())?;
    let key = path_key(req.uri());
    let body = read_json(req.into_body()).await?;
    Ok(json_response(200, &app.service.update_flag(&key, &body)?.to_json()))
}

async fn delete_flag<R: Repository + 'static>(State(app): Shared<R>, req: Request) -> Handled {
    app.require_admin(req.headers())?;
    app.service.delete_flag(&path_key(req.uri()))?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn results<R: Repository + 'static>(State(app): Shared<R>, req: Request) -> Handled {
    app.require_admin(req.headers())?;
    let query = parse_query(req.uri().query());
    let goal = query.get("goal").and_then(|v| v.first()).map_or("", String::as_str);
    Ok(json_response(200, &app.service.results(&path_key(req.uri()), goal)?.to_json()))
}

async fn list_audit<R: Repository + 'static>(State(app): Shared<R>, req: Request) -> Handled {
    app.require_admin(req.headers())?;
    let query = parse_query(req.uri().query());
    let page = parse::page(&query)?;
    let flag_key = query.get("flagKey").and_then(|v| v.first()).map(String::as_str);
    let (logs, total) = app.service.list_audit(flag_key, page)?;
    let items: Vec<Value> = logs
        .iter()
        .map(|a| {
            let stored = |text: &Option<String>| text.as_deref().and_then(|t| serde_json::from_str::<Value>(t).ok());
            json!({"id": a.id, "flagKey": a.flag_key, "action": a.action, "before": stored(&a.before), "after": stored(&a.after), "createdAt": format_time(a.created_at)})
        })
        .collect();
    Ok(json_response(200, &json!({"items": items, "total": total})))
}

async fn evaluate<R: Repository + 'static>(State(app): Shared<R>, req: Request) -> Handled {
    app.require_client_or_admin(req.headers())?;
    let body = read_json(req.into_body()).await?;
    let results: serde_json::Map<String, Value> =
        app.service.evaluate(&body)?.into_iter().map(|(k, r)| (k, r.to_json())).collect();
    Ok(json_response(200, &json!({"results": results})))
}

async fn events<R: Repository + 'static>(State(app): Shared<R>, req: Request) -> Handled {
    app.require_client_or_admin(req.headers())?;
    let body = read_json(req.into_body()).await?;
    Ok(json_response(202, &json!({"accepted": app.service.record_events(&body)?})))
}

/// Unknown path, or a known path with another method (axum would say 405): both are "no such route" (BR-53).
async fn no_such_route() -> Response {
    error_response(Code::FlagNotFound, "no such route")
}

/// Runs around every request. A path with a broken percent escape ("%zz") is not a path at all: 400 in the standard
/// shape (a well-formed escape for bytes that are not UTF-8, "%FF", is not an error: it is a key no flag has, BR-55).
/// A panic in a handler would otherwise end the connection without an answer: the request runs in its own task, and
/// a task that panicked becomes an opaque 500.
async fn guard(State(cors_origins): State<Arc<Vec<String>>>, req: Request, next: Next) -> Response {
    if has_broken_escape(req.uri().path()) {
        return error_response(Code::Validation, "malformed request");
    }
    let (method, path) = (req.method().clone(), req.uri().path().to_string());
    let cors = cors_allow(&cors_origins, &method, &path, req.headers());
    if let (Some(allow), true) = (&cors, method == axum::http::Method::OPTIONS) {
        // a preflight is answered here, without a key
        let mut response = Response::new(Body::empty());
        *response.status_mut() = StatusCode::NO_CONTENT;
        let h = response.headers_mut();
        add_cors_origin(h, allow);
        h.insert("access-control-allow-methods", "POST".parse().unwrap());
        h.insert("access-control-allow-headers", "Content-Type, X-Client-Key".parse().unwrap());
        h.insert("access-control-max-age", "600".parse().unwrap());
        return response;
    }
    let mut response = match tokio::spawn(next.run(req)).await {
        Ok(response) => response,
        Err(e) => {
            eprintln!("internal error serving {method} {path}: {e}");
            error_response(Code::Internal, "internal error")
        }
    };
    if let Some(allow) = &cors {
        add_cors_origin(response.headers_mut(), allow);
    }
    response
}

/// BR-56: the value for Access-Control-Allow-Origin when this is a POST or preflight to a client endpoint from an
/// allowed Origin, else None.
fn cors_allow(origins: &[String], method: &axum::http::Method, path: &str, headers: &HeaderMap) -> Option<String> {
    let origin = headers.get(header::ORIGIN)?.to_str().ok()?;
    if !(path == "/v1/evaluate" || path == "/v1/events") || !(method == "POST" || method == "OPTIONS") {
        return None;
    }
    if origins.iter().any(|o| o == "*") {
        Some("*".to_string())
    } else if origins.iter().any(|o| o == origin) {
        Some(origin.to_string())
    } else {
        None
    }
}

fn add_cors_origin(headers: &mut HeaderMap, allow: &str) {
    // The value is a request header that parsed as text, so it is a valid header value.
    headers.insert("access-control-allow-origin", allow.parse().unwrap());
    if allow != "*" {
        headers.insert(header::VARY, "Origin".parse().unwrap());
    }
}

/// Build the HTTP application with CORS off. Both keys are required (BR-10).
pub fn router<R: Repository + 'static>(
    service: Service<R>,
    admin_key: &str,
    client_key: &str,
) -> Result<Router, String> {
    router_with_cors(service, admin_key, client_key, &[])
}

/// Like [`router`], with the origins that may call evaluate and events from a browser (BR-56; "*" allows all).
pub fn router_with_cors<R: Repository + 'static>(
    service: Service<R>,
    admin_key: &str,
    client_key: &str,
    cors_origins: &[String],
) -> Result<Router, String> {
    if admin_key.is_empty() || client_key.is_empty() {
        return Err("both an admin key and a client key are required".into());
    }
    let app =
        Arc::new(App { service, admin_key: admin_key.as_bytes().to_vec(), client_key: client_key.as_bytes().to_vec() });
    Ok(Router::new()
        .route("/healthz", get(healthz))
        .route("/v1/flags", get(list_flags::<R>).post(create_flag::<R>))
        .route("/v1/flags/{key}", get(get_flag::<R>).put(update_flag::<R>).delete(delete_flag::<R>))
        .route("/v1/flags/{key}/results", get(results::<R>))
        .route("/v1/audit-logs", get(list_audit::<R>))
        .route("/v1/evaluate", post(evaluate::<R>))
        .route("/v1/events", post(events::<R>))
        .fallback(no_such_route)
        .method_not_allowed_fallback(no_such_route)
        .layer(middleware::from_fn_with_state(Arc::new(cors_origins.to_vec()), guard))
        .with_state(app))
}

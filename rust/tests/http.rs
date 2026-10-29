//! The HTTP layer through a real server on a free port and a raw socket, so that the bytes on the wire are exactly
//! what each test says: an HTTP client library would refuse to send many of these requests.

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::TcpStream;

use ffservice::handler::{MAX_BODY_BYTES, router};
use ffservice::repository::SqliteRepository;
use ffservice::service::Service;
use serde_json::{Value, json};

const ADMIN: &str = "test-admin-key";
const CLIENT: &str = "test-client-key";

/// A server with its own in-memory database, on its own runtime thread. It ends with the test process.
struct Server {
    port: u16,
}

fn start() -> Server {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let app = router(Service::new(SqliteRepository::open(":memory:").unwrap()), ADMIN, CLIENT).unwrap();
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            tx.send(listener.local_addr().unwrap().port()).unwrap();
            axum::serve(listener, app).await.unwrap();
        });
    });
    Server { port: rx.recv().unwrap() }
}

struct Response {
    status: u16,
    headers: BTreeMap<String, String>,
    body: Vec<u8>,
}

impl Response {
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }

    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or_else(|e| panic!("not JSON ({e}): {}", self.text()))
    }

    fn code(&self) -> String {
        self.json()["error"]["code"].as_str().unwrap_or("").to_string()
    }
}

#[derive(Default)]
struct Req<'a> {
    method: &'a str,
    target: String,
    body: Vec<u8>,
    auth: &'a str,
    headers: Vec<(&'a str, Vec<u8>)>,
}

impl Server {
    fn send(&self, r: Req) -> Response {
        let mut headers: Vec<(String, Vec<u8>)> = vec![];
        match r.auth {
            "admin" => headers.push(("X-Admin-Key".into(), ADMIN.into())),
            "client" => headers.push(("X-Client-Key".into(), CLIENT.into())),
            "bad" => {
                headers.push(("X-Admin-Key".into(), b"wrong".to_vec()));
                headers.push(("X-Client-Key".into(), b"wrong".to_vec()));
            }
            _ => {}
        }
        for (k, v) in &r.headers {
            headers.push(((*k).to_string(), v.clone()));
        }
        if !headers.iter().any(|(k, _)| k.eq_ignore_ascii_case("content-type")) {
            headers.push(("Content-Type".into(), b"application/json".to_vec()));
        }
        let mut wire = format!(
            "{} {} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Length: {}\r\n",
            r.method,
            r.target,
            r.body.len()
        )
        .into_bytes();
        for (k, v) in &headers {
            wire.extend_from_slice(k.as_bytes());
            wire.extend_from_slice(b": ");
            wire.extend_from_slice(v);
            wire.extend_from_slice(b"\r\n");
        }
        wire.extend_from_slice(b"\r\n");
        wire.extend_from_slice(&r.body);

        let mut stream = TcpStream::connect(("127.0.0.1", self.port)).unwrap();
        stream.set_read_timeout(Some(std::time::Duration::from_secs(30))).unwrap();
        // A server may answer and close while a big body is still being written: a write error is then fine as long as
        // the answer can still be read.
        let _ = stream.write_all(&wire);
        let mut all = vec![];
        let _ = stream.read_to_end(&mut all);
        parse_response(&all)
    }

    fn call(&self, method: &str, target: &str, body: &str, auth: &str) -> Response {
        self.send(Req { method, target: target.into(), body: body.as_bytes().to_vec(), auth, headers: vec![] })
    }
}

fn parse_response(all: &[u8]) -> Response {
    let split = all
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .unwrap_or_else(|| panic!("no end of headers in {:?}", String::from_utf8_lossy(all)));
    let head = String::from_utf8_lossy(&all[..split]).into_owned();
    let mut lines = head.split("\r\n");
    let status = lines.next().unwrap().split(' ').nth(1).unwrap().parse().unwrap();
    let headers =
        lines.filter_map(|l| l.split_once(':')).map(|(k, v)| (k.to_ascii_lowercase(), v.trim().to_string())).collect();
    let rest = &all[split + 4..];
    let body =
        if head.to_ascii_lowercase().contains("transfer-encoding: chunked") { dechunk(rest) } else { rest.to_vec() };
    Response { status, headers, body }
}

fn dechunk(mut rest: &[u8]) -> Vec<u8> {
    let mut out = vec![];
    while let Some(eol) = rest.windows(2).position(|w| w == b"\r\n") {
        let size = usize::from_str_radix(std::str::from_utf8(&rest[..eol]).unwrap().trim(), 16).unwrap_or(0);
        if size == 0 {
            break;
        }
        out.extend_from_slice(&rest[eol + 2..eol + 2 + size]);
        rest = &rest[eol + 2 + size + 2..];
    }
    out
}

fn assert_error(r: &Response, status: u16, code: &str) {
    assert_eq!(r.status, status, "{}", r.text());
    assert_eq!(r.code(), code, "{}", r.text());
    assert!(r.headers["content-type"].starts_with("application/json"), "{:?}", r.headers);
}

// -------------------------------------------------------------------- tests

#[test]
fn both_keys_are_required() {
    for (admin, client) in [("", "c"), ("a", ""), ("", "")] {
        let service = Service::new(SqliteRepository::open(":memory:").unwrap());
        assert!(router(service, admin, client).is_err());
    }
}

#[test]
fn br13_healthz_needs_no_key() {
    let r = start().call("GET", "/healthz", "", "none");
    assert_eq!((r.status, r.json()), (200, json!({"status": "ok"})));
}

#[test]
fn br10_br12_admin_endpoints_accept_only_the_admin_key() {
    let s = start();
    for (method, path) in [
        ("GET", "/v1/flags"),
        ("POST", "/v1/flags"),
        ("GET", "/v1/flags/x"),
        ("PUT", "/v1/flags/x"),
        ("DELETE", "/v1/flags/x"),
        ("GET", "/v1/flags/x/results?goal=g"),
        ("GET", "/v1/audit-logs"),
    ] {
        assert_error(&s.call(method, path, "{}", "none"), 401, "UNAUTHORIZED");
        assert_error(&s.call(method, path, "{}", "bad"), 401, "UNAUTHORIZED");
        assert_error(&s.call(method, path, "{}", "client"), 403, "FORBIDDEN");
    }
}

#[test]
fn br11_client_endpoints_accept_either_key() {
    let s = start();
    for (path, body) in
        [("/v1/evaluate", "{}"), ("/v1/events", r#"{"events":[{"type":"conversion","userId":"u","goal":"g"}]}"#)]
    {
        assert!([200, 202].contains(&s.call("POST", path, body, "admin").status));
        assert!([200, 202].contains(&s.call("POST", path, body, "client").status));
        assert_eq!(s.call("POST", path, body, "none").status, 401);
        assert_eq!(s.call("POST", path, body, "bad").status, 401);
    }
}

#[test]
fn br51_auth_is_checked_before_the_body_is_read() {
    let s = start();
    assert_eq!(s.call("POST", "/v1/flags", "not json", "none").status, 401);
    assert_eq!(s.call("POST", "/v1/flags", "not json", "client").status, 403);
    assert_eq!(s.call("POST", "/v1/flags", "not json", "admin").status, 400);
}

#[test]
fn non_ascii_key_headers_are_a_wrong_key_not_a_crash() {
    let s = start();
    for value in [b"caf\xe9".to_vec(), b"\xff\xfe".to_vec(), vec![b'a'; 5000]] {
        let r = s.send(Req {
            method: "GET",
            target: "/v1/flags".into(),
            auth: "none",
            headers: vec![("X-Admin-Key", value)],
            ..Req::default()
        });
        assert_error(&r, 401, "UNAUTHORIZED");
    }
    let r = s.send(Req {
        method: "GET",
        target: "/v1/flags".into(),
        auth: "admin",
        headers: vec![("X-Client-Key", vec![0xe9])],
        ..Req::default()
    });
    assert_eq!(r.status, 200);
}

#[test]
fn status_codes_and_content_type_of_the_happy_path() {
    let s = start();
    let created = s.call("POST", "/v1/flags", r#"{"key":"f","enabled":true}"#, "admin");
    assert_eq!(created.status, 201);
    assert!(created.headers["content-type"].starts_with("application/json"));
    assert_eq!(created.json()["key"], "f");
    assert_eq!(s.call("GET", "/v1/flags/f", "", "admin").status, 200);
    assert_eq!(s.call("PUT", "/v1/flags/f", r#"{"key":"f"}"#, "admin").status, 200);
    assert_eq!(s.call("GET", "/v1/flags", "", "admin").json()["total"], 1);
    assert_eq!(s.call("GET", "/v1/audit-logs?flagKey=f", "", "admin").json()["total"], 2);
    assert_eq!(
        s.call("POST", "/v1/evaluate", r#"{"flags":["f"]}"#, "client").json()["results"]["f"]["reason"],
        "DISABLED"
    );
    assert_eq!(
        s.call("POST", "/v1/events", r#"{"events":[{"type":"conversion","userId":"u","goal":"g"}]}"#, "client").json(),
        json!({"accepted": 1})
    );
    let deleted = s.call("DELETE", "/v1/flags/f", "", "admin");
    assert_eq!((deleted.status, deleted.body.len()), (204, 0));
    assert_error(&s.call("GET", "/v1/flags/f", "", "admin"), 404, "FLAG_NOT_FOUND");
}

#[test]
fn br52_bodies_that_are_not_one_json_value_are_validation_errors() {
    let s = start();
    let long_number = format!(r#"{{"key":"x","rolloutPercent":1{}}}"#, "0".repeat(5000));
    let bodies: Vec<&str> = vec![
        "",
        "   ",
        "{",
        "[",
        r#"{"key":"x"} {"key":"y"}"#,
        r#"{"key":"x"} x"#,
        r#"{"key":"x"},"#,
        "NaN",
        r#"{"key":"x","unknown":NaN}"#,
        r#"{"key":"x","unknown":Infinity}"#,
        r#"{"key":"x","unknown":-Infinity}"#,
        r#"{"key":"x","rolloutPercent":01}"#,
        r#"{"key":"x","rolloutPercent":.5}"#,
        r#"{"key":"x","rolloutPercent":1.}"#,
        r#"{"key":"x","rolloutPercent":+1}"#,
        r#"{"key":"x",}"#,
        "{'key':'x'}",
        r#"{"key":"x"} // c"#,
        "{\"key\":\"a\nb\"}",
        "\u{feff}{\"key\":\"x\"}",
        "{\"key\":\"x\"}\0",
        r#"{"key":"x","rolloutPercent":1e999}"#,
        &long_number,
    ];
    for body in bodies {
        assert_error(&s.call("POST", "/v1/flags", body, "admin"), 400, "VALIDATION_ERROR");
    }
}

#[test]
fn br52_deep_nesting_is_a_400_not_a_crash() {
    let s = start();
    let nested = format!(r#"{{"key":"deep","description":{}{}}}"#, "[".repeat(20_000), "]".repeat(20_000));
    for body in ["[".repeat(100_000), r#"{"a":"#.repeat(50_000), nested] {
        assert_error(&s.call("POST", "/v1/flags", &body, "admin"), 400, "VALIDATION_ERROR");
    }
    assert_error(&s.call("GET", "/v1/flags/deep", "", "admin"), 404, "FLAG_NOT_FOUND");
}

fn utf16(s: &str, le: bool, bom: bool) -> Vec<u8> {
    let mut out = if bom { vec![0xff, 0xfe] } else { vec![] };
    for unit in s.encode_utf16() {
        out.extend_from_slice(&if le { unit.to_le_bytes() } else { unit.to_be_bytes() });
    }
    out
}

#[test]
fn br52_invalid_utf8_and_utf16_are_rejected_not_repaired() {
    let s = start();
    let around = |middle: &[u8]| [br#"{"key":"x","description":""#.as_slice(), middle, br#""}"#.as_slice()].concat();
    let bodies = [
        around(&[0xff]),
        around(&[0xc3, 0x28]),
        around(&[0xed, 0xa0, 0x80]),
        around(&[0xc0, 0xaf]),
        utf16(r#"{"key":"x"}"#, true, true),
        utf16(r#"{"key":"x"}"#, true, false),
        utf16(r#"{"key":"x"}"#, false, false),
    ];
    for body in bodies {
        let r = s.send(Req { method: "POST", target: "/v1/flags".into(), body, auth: "admin", ..Req::default() });
        assert_error(&r, 400, "VALIDATION_ERROR");
    }
    assert_error(&s.call("GET", "/v1/flags/x", "", "admin"), 404, "FLAG_NOT_FOUND");
}

#[test]
fn br52_duplicate_keys_last_wins_and_content_type_is_ignored() {
    let s = start();
    let with_type = |method: &'static str, target: &str, body: &str, content_type: &'static str| {
        s.send(Req {
            method,
            target: target.into(),
            body: body.as_bytes().to_vec(),
            auth: "admin",
            headers: vec![("Content-Type", content_type.as_bytes().to_vec())],
        })
    };
    let r = with_type("POST", "/v1/flags", r#"{"key":"first","key":"second"}"#, "text/plain");
    assert_eq!((r.status, r.json()["key"].clone()), (201, json!("second")));
    assert_eq!(with_type("POST", "/v1/flags", r#"{"key":"third"}"#, "application/x-www-form-urlencoded").status, 201);
    assert_eq!(
        with_type("PUT", "/v1/flags/third", r#"{"key":"third","enabled":true}"#, "application/x-www-form-urlencoded")
            .status,
        200
    );
}

#[test]
fn br52_an_oversized_body_is_rejected_not_crashed() {
    let s = start();
    let padding = " ".repeat(MAX_BODY_BYTES + 1);
    assert_error(
        &s.call("POST", "/v1/flags", &format!(r#"{{"key":"big"}}{padding}"#), "admin"),
        400,
        "VALIDATION_ERROR",
    );
    assert_eq!(
        s.call("POST", "/v1/flags", &format!(r#"{{"key":"fits"}}{}"#, " ".repeat(MAX_BODY_BYTES - 20)), "admin").status,
        201
    );
}

#[test]
fn br54_lone_surrogates_are_never_a_server_error() {
    let s = start();
    s.call(
        "POST",
        "/v1/flags",
        r#"{"key":"f","enabled":true,"variants":[{"key":"a","weight":50},{"key":"b","weight":50}]}"#,
        "admin",
    );
    let eval = |id: &str| {
        s.call("POST", "/v1/evaluate", &format!(r#"{{"flags":["f"],"context":{{"userId":"{id}"}}}}"#), "client")
    };
    let replacement = eval("\\ufffd");
    assert_eq!(replacement.status, 200);
    for lone in ["\\ud800", "\\udc00", "\\ud83d"] {
        let r = eval(lone);
        assert!(r.status < 500, "{lone}: {}", r.status); // serde_json refuses a lone surrogate escape: a 400 is allowed
        if r.status == 200 {
            assert_eq!(r.json(), replacement.json(), "{lone}");
        }
    }
    let created = s.call("POST", "/v1/flags", r#"{"key":"g","description":"\ud800"}"#, "admin");
    assert!(created.status < 500);
    assert_eq!(s.call("GET", "/v1/flags?limit=100", "", "admin").status, 200);
}

#[test]
fn br55_a_path_key_that_is_not_utf8_is_just_not_found() {
    let s = start();
    for key in ["%FF", "%C3%28", "%ED%A0%80", "%C0%AF", "%00", "%7F", "a%FFb", "%F0%9F%98"] {
        assert_error(&s.call("GET", &format!("/v1/flags/{key}"), "", "admin"), 404, "FLAG_NOT_FOUND");
        assert_error(&s.call("DELETE", &format!("/v1/flags/{key}"), "", "admin"), 404, "FLAG_NOT_FOUND");
        assert_error(&s.call("GET", &format!("/v1/flags/{key}/results?goal=g"), "", "admin"), 404, "FLAG_NOT_FOUND");
    }
}

#[test]
fn a_broken_percent_escape_is_a_400_not_a_404() {
    let s = start();
    for target in ["/v1/flags/%zz", "/v1/flags/a%", "/v1/flags/%4", "/nope%zz"] {
        assert_error(&s.call("GET", target, "", "admin"), 400, "VALIDATION_ERROR");
    }
}

#[test]
fn an_encoded_slash_is_part_of_the_key_not_a_path_separator() {
    let s = start();
    assert_eq!(s.call("GET", "/v1/flags/a%2Fb", "", "none").status, 401);
    assert_eq!(s.call("GET", "/v1/flags/a%2Fb", "", "client").status, 403);
    assert_error(&s.call("GET", "/v1/flags/a%2fb", "", "admin"), 404, "FLAG_NOT_FOUND");
    assert_error(&s.call("DELETE", "/v1/flags/a%2Fb", "", "admin"), 404, "FLAG_NOT_FOUND");
    assert_error(&s.call("PUT", "/v1/flags/a%2Fb", r#"{"key":"a/b"}"#, "admin"), 400, "INVALID_KEY");
    assert_error(&s.call("PUT", "/v1/flags/a%2Fb", r#"{"key":"ab"}"#, "admin"), 400, "KEY_IMMUTABLE");
    assert_error(&s.call("GET", "/v1/flags/a/b", "", "admin"), 404, "FLAG_NOT_FOUND");
    assert_error(&s.call("GET", "/v1/flags/a%252Fb", "", "admin"), 404, "FLAG_NOT_FOUND");
}

#[test]
fn a_percent_encoded_path_key_is_decoded_before_the_lookup() {
    let s = start();
    s.call("POST", "/v1/flags", r#"{"key":"a-b","enabled":true}"#, "admin");
    for target in ["/v1/flags/a%2Db", "/v1/flags/%61-%62", "/v1/flags/a-b"] {
        assert_eq!(s.call("GET", target, "", "admin").json()["key"], "a-b", "{target}");
    }
    assert_eq!(s.call("GET", "/v1/flags/a%2Db/results?goal=g", "", "admin").status, 200);
    assert_eq!(s.call("PUT", "/v1/flags/%61%2Db", r#"{"key":"a-b","description":"d"}"#, "admin").status, 200);
    assert_eq!(s.call("DELETE", "/v1/flags/a%2db", "", "admin").status, 204);
}

#[test]
fn a_semicolon_in_a_path_key_is_part_of_the_key() {
    let s = start();
    s.call("POST", "/v1/flags", r#"{"key":"a"}"#, "admin");
    assert_error(&s.call("GET", "/v1/flags/a;b", "", "admin"), 404, "FLAG_NOT_FOUND"); // not flag "a"
    assert_eq!(s.call("GET", "/v1/flags/a", "", "admin").status, 200);
}

#[test]
fn br53_unknown_routes_answer_with_a_json_error_body_and_need_no_key() {
    let s = start();
    for (method, path) in [
        ("GET", "/nope"),
        ("GET", "/v1"),
        ("GET", "/v1/flags/"),
        ("GET", "/v1/flags/a/b"),
        ("PATCH", "/v1/flags"),
        ("POST", "/healthz"),
        ("GET", "/docs"),
        ("GET", "/openapi.json"),
        ("GET", "/error"),
        ("OPTIONS", "/v1/flags"),
        ("TRACE", "/v1/flags"),
        ("GET", "/v1/evaluate"),
        ("DELETE", "/v1/flags"),
        ("GET", "/v1/flags/a/results/x"),
    ] {
        assert_error(&s.call(method, path, "", "none"), 404, "FLAG_NOT_FOUND");
    }
}

#[test]
fn a_method_that_has_no_route_for_a_path_is_not_found_even_when_another_method_has() {
    let s = start();
    s.call("POST", "/v1/flags", r#"{"key":"m","description":"before"}"#, "admin");
    assert_error(
        &s.call("PATCH", "/v1/flags/m", r#"{"key":"m","description":"after"}"#, "admin"),
        404,
        "FLAG_NOT_FOUND",
    );
    assert_error(&s.call("POST", "/v1/flags/m", r#"{"key":"m"}"#, "admin"), 404, "FLAG_NOT_FOUND");
    assert_error(&s.call("PUT", "/v1/flags", r#"{"key":"m"}"#, "admin"), 404, "FLAG_NOT_FOUND");
    assert_error(&s.call("POST", "/v1/flags/m/results?goal=g", "", "admin"), 404, "FLAG_NOT_FOUND");
    assert_eq!(s.call("GET", "/v1/flags/m", "", "admin").json()["description"], "before");
}

#[test]
fn br50_the_first_value_of_a_repeated_query_parameter_counts() {
    let s = start();
    for key in ["a", "b", "c"] {
        s.call("POST", "/v1/flags", &format!(r#"{{"key":"{key}"}}"#), "admin");
    }
    let items = |target: &str| s.call("GET", target, "", "admin").json()["items"].as_array().unwrap().len();
    assert_eq!(items("/v1/flags?limit=1&limit=100"), 1);
    assert_eq!(s.call("GET", "/v1/flags?limit=100&limit=abc", "", "admin").status, 200);
    assert_eq!(s.call("GET", "/v1/flags?limit=abc&limit=1", "", "admin").status, 400);
    assert_eq!(s.call("GET", "/v1/flags?limit=%zz", "", "admin").status, 200); // a pair with a bad escape is ignored
    assert_eq!(s.call("GET", "/v1/flags?limit=2&offset=1", "", "admin").json()["total"], 3);
    assert_eq!(items("/v1/flags?limit=2&offset=1"), 2);
    assert_eq!(items("/v1/flags?limit=1;x=2&limit=1"), 1);
}

#[test]
fn query_values_are_percent_decoded_and_a_plus_is_a_space() {
    let s = start();
    s.call("POST", "/v1/flags", r#"{"key":"q","enabled":true}"#, "admin");
    for (raw, want) in
        [("buy+now", "buy now"), ("buy%20now", "buy now"), ("a%2Bb", "a+b"), ("%E0%B8%81", "\u{e01}"), ("x%3Dy", "x=y")]
    {
        assert_eq!(
            s.call("GET", &format!("/v1/flags/q/results?goal={raw}"), "", "admin").json()["goal"],
            want,
            "{raw}"
        );
    }
}

#[test]
fn every_error_code_maps_to_its_status() {
    let s = start();
    s.call("POST", "/v1/flags", r#"{"key":"f"}"#, "admin");
    let cases = [
        ("POST", "/v1/flags", r#"{"key":"f"}"#, 409, "FLAG_EXISTS"),
        ("POST", "/v1/flags", r#"{"key":"BAD"}"#, 400, "INVALID_KEY"),
        ("PUT", "/v1/flags/f", r#"{"key":"g"}"#, 400, "KEY_IMMUTABLE"),
        ("POST", "/v1/flags", r#"{"key":"x","variants":[{"key":"a","weight":100}]}"#, 400, "INVALID_VARIANTS"),
        ("POST", "/v1/flags", "[]", 400, "VALIDATION_ERROR"),
        ("GET", "/v1/flags/ghost", "", 404, "FLAG_NOT_FOUND"),
        ("GET", "/v1/flags/f/results", "", 400, "VALIDATION_ERROR"),
        ("GET", "/v1/flags/f/results?goal=", "", 400, "VALIDATION_ERROR"),
    ];
    for (method, path, body, status, code) in cases {
        assert_error(&s.call(method, path, body, "admin"), status, code);
    }
}

#[test]
fn an_error_body_has_a_code_and_a_message_and_nothing_else() {
    let r = start().call("GET", "/v1/flags/ghost", "", "admin");
    let error = r.json()["error"].clone();
    assert_eq!(error.as_object().unwrap().keys().collect::<Vec<_>>(), ["code", "message"]);
    assert!(!error["message"].as_str().unwrap().is_empty());
}

#[test]
fn head_is_answered_like_get_without_a_body() {
    let s = start();
    let r = s.call("HEAD", "/healthz", "", "none");
    assert_eq!(r.status, 200);
    assert!(r.body.is_empty());
}

// ----------------------------------------------------- a repository that fails

use std::collections::HashMap;

use ffservice::model::{AuditLog, Event, Flag};
use ffservice::repository::{RepoError, Repository, Tx};

/// Every call fails: with a storage error, or (`panic`) with a panic.
struct Broken {
    panic: bool,
}

impl Broken {
    fn fail<T>(&self) -> Result<T, RepoError> {
        assert!(!self.panic, "secret internal detail (a bug, not an error value)");
        Err(RepoError::Storage("secret internal detail: disk is full".into()))
    }
}

impl Repository for Broken {
    fn transaction<T>(&self, _work: impl FnOnce(&dyn Tx) -> Result<T, RepoError>) -> Result<T, RepoError> {
        self.fail()
    }
    fn get_flag(&self, _key: &str) -> Result<Flag, RepoError> {
        self.fail()
    }
    fn list_flags(&self, _limit: i64, _offset: i64) -> Result<(Vec<Flag>, u64), RepoError> {
        self.fail()
    }
    fn list_all_flags(&self) -> Result<Vec<Flag>, RepoError> {
        self.fail()
    }
    fn list_audit(
        &self,
        _flag_key: Option<&str>,
        _limit: i64,
        _offset: i64,
    ) -> Result<(Vec<AuditLog>, u64), RepoError> {
        self.fail()
    }
    fn record_events(&self, _events: &[Event]) -> Result<(), RepoError> {
        self.fail()
    }
    fn variant_counts(
        &self,
        _flag_key: &str,
        _goal: &str,
    ) -> Result<(HashMap<String, u64>, HashMap<String, u64>), RepoError> {
        self.fail()
    }
}

fn start_broken(panic: bool) -> Server {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let app = router(Service::new(Broken { panic }), ADMIN, CLIENT).unwrap();
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            tx.send(listener.local_addr().unwrap().port()).unwrap();
            axum::serve(listener, app).await.unwrap();
        });
    });
    Server { port: rx.recv().unwrap() }
}

#[test]
fn a_storage_failure_is_an_opaque_500() {
    let s = start_broken(false);
    let r = s.call("GET", "/v1/flags", "", "admin");
    assert_error(&r, 500, "INTERNAL_ERROR");
    assert!(!r.text().contains("secret") && !r.text().contains("disk"), "{}", r.text());
    assert_eq!(s.call("GET", "/healthz", "", "none").status, 200);
}

#[test]
fn a_panic_in_a_handler_is_an_opaque_500_and_the_server_carries_on() {
    let s = start_broken(true);
    let r = s.call("GET", "/v1/flags", "", "admin");
    assert_error(&r, 500, "INTERNAL_ERROR");
    assert!(!r.text().contains("secret"), "{}", r.text());
    assert_error(&s.call("POST", "/v1/evaluate", r#"{"flags":["x"]}"#, "client"), 500, "INTERNAL_ERROR");
    assert_eq!(s.call("GET", "/healthz", "", "none").status, 200);
}

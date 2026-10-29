//! Feature flag service: a Rust port of the Go reference in `go/`.
//!
//! Layers, with dependencies flowing one way: `handler` -> `service` -> `repository`, and
//! `service` -> `evaluation` -> `model`.

pub mod config;
pub mod erfc;
pub mod error;
pub mod evaluation;
pub mod handler;
pub mod model;
pub mod parse;
pub mod repository;
pub mod service;
pub mod timefmt;

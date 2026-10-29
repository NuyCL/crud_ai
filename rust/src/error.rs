//! Failures the client caused and can act on, as machine-readable codes (the enum in spec/openapi.yaml).

use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Code {
    Unauthorized,
    Forbidden,
    FlagNotFound,
    FlagExists,
    InvalidKey,
    KeyImmutable,
    InvalidVariants,
    Validation,
    Internal,
}

impl Code {
    pub fn as_str(self) -> &'static str {
        match self {
            Code::Unauthorized => "UNAUTHORIZED",
            Code::Forbidden => "FORBIDDEN",
            Code::FlagNotFound => "FLAG_NOT_FOUND",
            Code::FlagExists => "FLAG_EXISTS",
            Code::InvalidKey => "INVALID_KEY",
            Code::KeyImmutable => "KEY_IMMUTABLE",
            Code::InvalidVariants => "INVALID_VARIANTS",
            Code::Validation => "VALIDATION_ERROR",
            Code::Internal => "INTERNAL_ERROR",
        }
    }

    pub fn status(self) -> u16 {
        match self {
            Code::Unauthorized => 401,
            Code::Forbidden => 403,
            Code::FlagNotFound => 404,
            Code::FlagExists => 409,
            Code::InvalidKey | Code::KeyImmutable | Code::InvalidVariants | Code::Validation => 400,
            Code::Internal => 500,
        }
    }
}

/// A failure the client caused. The handler maps `code` to an HTTP status.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServiceError {
    pub code: Code,
    pub message: String,
}

impl ServiceError {
    pub fn new(code: Code, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }

    pub fn validation(message: impl Into<String>) -> Self {
        Self::new(Code::Validation, message)
    }

    pub fn variants(message: impl Into<String>) -> Self {
        Self::new(Code::InvalidVariants, message)
    }
}

impl fmt::Display for ServiceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code.as_str(), self.message)
    }
}

impl std::error::Error for ServiceError {}

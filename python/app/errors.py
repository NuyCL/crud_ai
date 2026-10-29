"""Failures the client caused and can act on, as machine-readable codes (the enum in spec/openapi.yaml)."""

from __future__ import annotations

CODE_UNAUTHORIZED = "UNAUTHORIZED"
CODE_FORBIDDEN = "FORBIDDEN"
CODE_FLAG_NOT_FOUND = "FLAG_NOT_FOUND"
CODE_FLAG_EXISTS = "FLAG_EXISTS"
CODE_INVALID_KEY = "INVALID_KEY"
CODE_KEY_IMMUTABLE = "KEY_IMMUTABLE"
CODE_INVALID_VARIANTS = "INVALID_VARIANTS"
CODE_VALIDATION = "VALIDATION_ERROR"
CODE_INTERNAL = "INTERNAL_ERROR"


class ServiceError(Exception):
    """A failure the client caused. The handler maps `code` to an HTTP status."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


def validation_error(message: str) -> ServiceError:
    return ServiceError(CODE_VALIDATION, message)


def variants_error(message: str) -> ServiceError:
    return ServiceError(CODE_INVALID_VARIANTS, message)

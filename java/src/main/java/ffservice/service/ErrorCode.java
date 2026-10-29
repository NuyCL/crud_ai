package ffservice.service;

/** Error codes, identical to the enum in spec/openapi.yaml, with the HTTP status the handler answers with. */
public enum ErrorCode {
  UNAUTHORIZED(401),
  FORBIDDEN(403),
  FLAG_NOT_FOUND(404),
  FLAG_EXISTS(409),
  INVALID_KEY(400),
  KEY_IMMUTABLE(400),
  INVALID_VARIANTS(400),
  VALIDATION_ERROR(400),
  INTERNAL_ERROR(500);

  private final int status;

  ErrorCode(int status) {
    this.status = status;
  }

  public int status() {
    return status;
  }
}

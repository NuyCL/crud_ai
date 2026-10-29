package ffservice.service;

/** A failure the client caused and can act on. The handler maps {@link #code()} to an HTTP status. */
public final class ServiceError extends RuntimeException {
  private static final long serialVersionUID = 1L;

  private final ErrorCode code;

  public ServiceError(ErrorCode code, String message) {
    super(message, null, false, false); // no stack trace: this is control flow, not a bug
    this.code = code;
  }

  public ErrorCode code() {
    return code;
  }

  public static ServiceError validation(String message) {
    return new ServiceError(ErrorCode.VALIDATION_ERROR, message);
  }

  public static ServiceError variants(String message) {
    return new ServiceError(ErrorCode.INVALID_VARIANTS, message);
  }
}

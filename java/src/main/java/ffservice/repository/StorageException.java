package ffservice.repository;

/** The database failed. Not the client's fault: the handler answers 500 and logs the cause. */
public final class StorageException extends RuntimeException {
  private static final long serialVersionUID = 1L;

  public StorageException(String message, Throwable cause) {
    super(message, cause);
  }
}

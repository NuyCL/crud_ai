package ffservice.repository;

/** Inserting a flag whose key is taken. */
public final class ExistsException extends RuntimeException {
  private static final long serialVersionUID = 1L;

  public ExistsException(String key) {
    super("already exists: " + key, null, false, false);
  }
}

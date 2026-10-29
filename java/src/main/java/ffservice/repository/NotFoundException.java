package ffservice.repository;

/** The flag does not exist. */
public final class NotFoundException extends RuntimeException {
  private static final long serialVersionUID = 1L;

  public NotFoundException(String key) {
    super("not found: " + key, null, false, false);
  }
}

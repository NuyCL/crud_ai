package ffservice.model;

import java.time.Instant;

/** One successful change to a flag. {@code before} and {@code after} are the whole flag as JSON text, or null. */
public record AuditLog(long id, String flagKey, String action, String before, String after, Instant createdAt) {
  public static final String CREATE = "create";
  public static final String UPDATE = "update";
  public static final String DELETE = "delete";
}

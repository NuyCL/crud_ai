package ffservice.model;

import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * A feature flag definition. {@code rules} and {@code variants} are never null; the timestamps are null until the
 * service sets them.
 */
public record Flag(
    String key,
    String description,
    boolean enabled,
    List<Rule> rules,
    int rolloutPercent,
    List<Variant> variants,
    Instant createdAt,
    Instant updatedAt) {

  private static final DateTimeFormatter TIME =
      DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC);

  /** RFC 3339 in UTC with millisecond precision, e.g. 2026-01-31T08:00:00.250Z. */
  public static String formatTime(Instant t) {
    return TIME.format(t);
  }

  public static Instant parseTime(String s) {
    return Instant.from(TIME.parse(s));
  }

  public Flag withTimes(Instant created, Instant updated) {
    return new Flag(key, description, enabled, rules, rolloutPercent, variants, created, updated);
  }

  public Map<String, Object> toJson() {
    Map<String, Object> json = new LinkedHashMap<>();
    json.put("key", key);
    json.put("description", description);
    json.put("enabled", enabled);
    json.put("rules", rules.stream().map(Rule::toJson).toList());
    json.put("rolloutPercent", rolloutPercent);
    json.put("variants", variants.stream().map(Variant::toJson).toList());
    json.put("createdAt", createdAt == null ? null : formatTime(createdAt));
    json.put("updatedAt", updatedAt == null ? null : formatTime(updatedAt));
    return json;
  }
}

package ffservice.model;

import java.util.LinkedHashMap;
import java.util.Map;

/** The outcome of evaluating one flag. {@code variant} is null (JSON null) unless the reason is VARIANT. */
public record EvaluationResult(boolean enabled, String variant, String reason) {
  public static final String FLAG_NOT_FOUND = "FLAG_NOT_FOUND";
  public static final String DISABLED = "DISABLED";
  public static final String TARGETING_MISS = "TARGETING_MISS";
  public static final String MISSING_USER_ID = "MISSING_USER_ID";
  public static final String NOT_IN_ROLLOUT = "NOT_IN_ROLLOUT";
  public static final String ON = "ON";
  public static final String VARIANT = "VARIANT";

  public Map<String, Object> toJson() {
    Map<String, Object> json = new LinkedHashMap<>();
    json.put("enabled", enabled);
    json.put("variant", variant);
    json.put("reason", reason);
    return json;
  }
}

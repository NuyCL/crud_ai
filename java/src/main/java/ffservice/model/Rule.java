package ffservice.model;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * One targeting condition. {@code value} is a scalar for eq/neq and a non-empty {@code List<Object>} of scalars for
 * in/not_in (scalar = String, Double or Boolean).
 */
public record Rule(String attribute, String operator, Object value) {
  public Map<String, Object> toJson() {
    Map<String, Object> json = new LinkedHashMap<>();
    json.put("attribute", attribute);
    json.put("operator", operator);
    json.put("value", value);
    return json;
  }
}

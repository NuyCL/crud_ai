package ffservice.model;

import java.util.LinkedHashMap;
import java.util.Map;

/** One arm of an experiment. The weights of a flag's variants sum to 100. */
public record Variant(String key, int weight) {
  public Map<String, Object> toJson() {
    Map<String, Object> json = new LinkedHashMap<>();
    json.put("key", key);
    json.put("weight", weight);
    return json;
  }
}

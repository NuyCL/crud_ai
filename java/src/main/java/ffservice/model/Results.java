package ffservice.model;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** The experiment report of one flag for one goal. */
public record Results(String flagKey, String goal, List<VariantResult> variants) {
  public Map<String, Object> toJson() {
    Map<String, Object> json = new LinkedHashMap<>();
    json.put("flagKey", flagKey);
    json.put("goal", goal);
    json.put("variants", variants.stream().map(VariantResult::toJson).toList());
    return json;
  }
}

package ffservice.model;

import java.util.LinkedHashMap;
import java.util.Map;

/** One row of an experiment report. {@code pValue} is null when it is not reported (BR-42). */
public record VariantResult(
    String variant, int exposures, int conversions, double rate, Double pValue, boolean significant) {
  public Map<String, Object> toJson() {
    Map<String, Object> json = new LinkedHashMap<>();
    json.put("variant", variant);
    json.put("exposures", exposures);
    json.put("conversions", conversions);
    json.put("rate", rate);
    json.put("pValue", pValue);
    json.put("significant", significant);
    return json;
  }
}

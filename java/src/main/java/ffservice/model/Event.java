package ffservice.model;

/** A validated exposure (flagKey, variant) or conversion (goal). Unused fields are empty strings. */
public record Event(String type, String userId, String flagKey, String variant, String goal) {
  public static final String EXPOSURE = "exposure";
  public static final String CONVERSION = "conversion";
}

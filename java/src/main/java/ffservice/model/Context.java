package ffservice.model;

import java.util.Map;

/** What a flag is evaluated for. {@code userId} is not an attribute: rules cannot target it. */
public record Context(String userId, Map<String, Object> attributes) {
  public static final Context EMPTY = new Context("", Map.of());
}

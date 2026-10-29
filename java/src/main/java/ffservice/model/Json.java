package ffservice.model;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;

/**
 * JSON in and out for the whole service. Jackson is configured to be strict (RFC 8259): it rejects NaN, leading
 * zeros, comments, single quotes and trailing commas by default, and here also anything after the first value.
 * Floating point numbers come back as BigDecimal so that 10, 10.0 and 1e1 stay distinguishable from 10.5 until
 * {@link Scalars} turns them into doubles.
 */
public final class Json {
  private static final ObjectMapper MAPPER = new ObjectMapper()
      .enable(DeserializationFeature.USE_BIG_DECIMAL_FOR_FLOATS)
      .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS);

  private Json() {
  }

  /**
   * Parse exactly one JSON value from text. The text must already be valid UTF-16, i.e. decoded from UTF-8 strictly:
   * Jackson's own byte-level decoder would accept UTF-16 and UTF-32 documents (BR-52).
   *
   * @throws JsonProcessingException for anything that is not one strict JSON value
   */
  public static Object parse(String text) throws JsonProcessingException {
    return MAPPER.readValue(text, Object.class);
  }

  /** Serialise to UTF-8 bytes. */
  public static byte[] write(Object value) {
    try {
      return MAPPER.writeValueAsBytes(value);
    } catch (JsonProcessingException e) {
      throw new IllegalStateException("cannot serialise " + value.getClass(), e);
    }
  }

  /** Serialise to a string (used for the JSON columns of the database). */
  public static String stringify(Object value) {
    return new String(write(value), StandardCharsets.UTF_8);
  }
}

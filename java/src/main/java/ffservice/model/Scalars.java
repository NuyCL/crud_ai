package ffservice.model;

import java.math.BigDecimal;
import java.math.BigInteger;

/**
 * Scalars in rules and attributes are String, Double or Boolean. Numbers are always Double so that equality never
 * depends on how a number was written in JSON. JSON gives Integer, Long, BigInteger, BigDecimal or Double
 * depending on the text, and Boolean is not a Number in Java (unlike Python's bool), but both are handled here
 * in one place.
 */
public final class Scalars {
  private static final BigDecimal INT_LIMIT = BigDecimal.valueOf(1_000_000_000);

  private Scalars() {
  }

  /** The scalar for a decoded JSON value, or null if it is not one (null, array, object, number beyond a double). */
  public static Object of(Object value) {
    if (value instanceof String || value instanceof Boolean) {
      return value;
    }
    if (value instanceof BigDecimal || value instanceof BigInteger) {
      return toDouble(value instanceof BigInteger i ? new BigDecimal(i) : (BigDecimal) value);
    }
    if (value instanceof Number n) {
      double d = n.doubleValue();
      return Double.isFinite(d) ? (Double) d : null;
    }
    return null;
  }

  private static Double toDouble(BigDecimal value) {
    // BigDecimal.doubleValue() is correctly rounded but slow for exponents in the billions: decide first.
    long magnitude = (long) value.precision() - value.scale(); // value is about 10^magnitude
    if (value.signum() == 0 || magnitude < -400) {
      return 0.0;
    }
    if (magnitude > 309) {
      return null;
    }
    double d = value.doubleValue();
    return Double.isFinite(d) ? (Double) d : null;
  }

  /** An integer within +-1e9 from a JSON number with no fractional part (10 or 10.0), else null. Never a Boolean. */
  public static Integer asInt(Object value) {
    BigDecimal decimal;
    if (value instanceof BigDecimal d) {
      decimal = d;
    } else if (value instanceof BigInteger i) {
      decimal = new BigDecimal(i);
    } else if (value instanceof Integer || value instanceof Long) {
      decimal = BigDecimal.valueOf(((Number) value).longValue());
    } else if (value instanceof Double d && Double.isFinite(d)) {
      decimal = BigDecimal.valueOf(d);
    } else {
      return null;
    }
    if (decimal.abs().compareTo(INT_LIMIT) > 0) {
      return null;
    }
    if (decimal.signum() != 0 && decimal.stripTrailingZeros().scale() > 0) {
      return null; // a fractional part
    }
    return decimal.intValue();
  }
}

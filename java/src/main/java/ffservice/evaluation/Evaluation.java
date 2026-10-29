package ffservice.evaluation;

import ffservice.model.Context;
import ffservice.model.EvaluationResult;
import ffservice.model.Flag;
import ffservice.model.Rule;
import ffservice.model.Variant;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;

/**
 * Decides what a flag means for a user. A pure function of its arguments: no I/O, no clock, no randomness. The rules
 * are defined in spec/evaluation.md and checked against tests/vectors.
 */
public final class Evaluation {
  private static final int BUCKETS = 10_000;
  private static final int FNV_OFFSET = 0x811c9dc5;
  private static final int FNV_PRIME = 16_777_619;

  private Evaluation() {
  }

  /**
   * 32-bit FNV-1a of the UTF-8 bytes of s, as an unsigned value in a long.
   *
   * <p>Java's int multiplication wraps at 2^32 by itself, which is what the hash needs, but a Java byte is signed,
   * so each byte is masked to 0..255 before the xor; and the result is read as unsigned. A string with a lone
   * surrogate would encode as '?'; the handler removes those first (BR-54).
   */
  public static long fnv1a32(String s) {
    int h = FNV_OFFSET;
    for (byte b : s.getBytes(StandardCharsets.UTF_8)) {
      h ^= b & 0xff;
      h *= FNV_PRIME;
    }
    return Integer.toUnsignedLong(h);
  }

  /** Map (flagKey, salt, userId) to 0..9999. */
  public static int bucket(String flagKey, String salt, String userId) {
    return (int) (fnv1a32(flagKey + ":" + salt + ":" + userId) % BUCKETS);
  }

  /** Evaluate flag for ctx. A null flag means the flag does not exist. */
  public static EvaluationResult evaluate(Flag flag, Context ctx) {
    if (flag == null) {
      return off(EvaluationResult.FLAG_NOT_FOUND);
    }
    if (!flag.enabled()) {
      return off(EvaluationResult.DISABLED);
    }
    for (Rule rule : flag.rules()) {
      if (!ruleMatches(rule, ctx.attributes())) {
        return off(EvaluationResult.TARGETING_MISS);
      }
    }

    boolean needsBucket = flag.rolloutPercent() < 100 || !flag.variants().isEmpty();
    if (needsBucket && ctx.userId().isEmpty()) {
      return off(EvaluationResult.MISSING_USER_ID);
    }
    if (flag.rolloutPercent() < 100 && bucket(flag.key(), "rollout", ctx.userId()) >= flag.rolloutPercent() * 100) {
      return off(EvaluationResult.NOT_IN_ROLLOUT);
    }
    if (flag.variants().isEmpty()) {
      return new EvaluationResult(true, null, EvaluationResult.ON);
    }

    int b = bucket(flag.key(), "variant", ctx.userId());
    int threshold = 0;
    for (Variant v : flag.variants()) {
      threshold += v.weight() * 100;
      if (b < threshold) {
        return new EvaluationResult(true, v.key(), EvaluationResult.VARIANT);
      }
    }
    // Unreachable while the weights sum to 100, which the service guarantees.
    return off(EvaluationResult.DISABLED);
  }

  private static EvaluationResult off(String reason) {
    return new EvaluationResult(false, null, reason);
  }

  /** A missing attribute makes every operator fail, including neq and not_in. */
  private static boolean ruleMatches(Rule rule, Map<String, Object> attrs) {
    if (!attrs.containsKey(rule.attribute())) {
      return false;
    }
    Object got = attrs.get(rule.attribute());
    return switch (rule.operator()) {
      case "eq" -> scalarEqual(got, rule.value());
      case "neq" -> !scalarEqual(got, rule.value());
      case "in" -> contains(rule.value(), got);
      case "not_in" -> !contains(rule.value(), got);
      default -> false;
    };
  }

  private static boolean contains(Object list, Object got) {
    if (!(list instanceof List<?> items)) {
      return false;
    }
    for (Object item : items) {
      if (scalarEqual(got, item)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Equality without conversion: "1" is not 1, true is not "true", and true is not 1. All numbers are compared as
   * primitive doubles: {@code Double.equals} would say NaN equals NaN and 0.0 differs from -0.0.
   */
  static boolean scalarEqual(Object a, Object b) {
    if (a instanceof Boolean x) {
      return b instanceof Boolean y && x.booleanValue() == y.booleanValue();
    }
    if (a instanceof String x) {
      return b instanceof String y && x.equals(y);
    }
    if (a instanceof Number x) {
      return b instanceof Number y && x.doubleValue() == y.doubleValue();
    }
    return false;
  }
}

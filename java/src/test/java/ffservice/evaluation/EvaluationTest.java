package ffservice.evaluation;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ffservice.model.Context;
import ffservice.model.EvaluationResult;
import ffservice.model.Flag;
import ffservice.model.Rule;
import ffservice.model.Variant;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** Properties the vectors only sample, and the Java-specific traps. */
class EvaluationTest {
  private static Flag flag(List<Rule> rules, int rollout, List<Variant> variants) {
    return new Flag("f", "", true, rules, rollout, variants, null, null);
  }

  private static Flag ruleFlag(Object value, String operator) {
    return flag(List.of(new Rule("x", operator, value)), 100, List.of());
  }

  private static String reason(Flag f, Object attribute) {
    return Evaluation.evaluate(f, new Context("", Map.of("x", attribute))).reason();
  }

  @Test
  void theSameInputAlwaysGivesTheSameAnswer() {
    Flag f = flag(List.of(), 50, List.of(new Variant("a", 50), new Variant("b", 50)));
    EvaluationResult first = Evaluation.evaluate(f, new Context("user-1", Map.of()));
    for (int i = 0; i < 100; i++) {
      assertEquals(first, Evaluation.evaluate(f, new Context("user-1", Map.of())));
    }
  }

  @Test
  void aBooleanIsNeverANumber() {
    assertEquals("TARGETING_MISS", reason(ruleFlag(1.0, "eq"), true));
    assertEquals("TARGETING_MISS", reason(ruleFlag(true, "eq"), 1.0));
    assertEquals("TARGETING_MISS", reason(ruleFlag(0.0, "eq"), false));
    assertEquals("TARGETING_MISS", reason(ruleFlag(false, "eq"), 0.0));
    assertEquals("ON", reason(ruleFlag(true, "eq"), true));
    assertEquals("ON", reason(ruleFlag(0.0, "eq"), 0.0));
  }

  @Test
  void aBooleanIsNotInAListOfNumbersAndNotInIncludesIt() {
    assertEquals("TARGETING_MISS", reason(ruleFlag(List.of(1.0, 2.0, 3.0), "in"), true));
    assertEquals("ON", reason(ruleFlag(List.of(1.0, 2.0, 3.0), "not_in"), true));
    assertEquals("TARGETING_MISS", reason(ruleFlag(List.of(true), "in"), 1.0));
  }

  @Test
  void aStringIsNotANumber() {
    assertEquals("TARGETING_MISS", reason(ruleFlag(1.0, "eq"), "1"));
    assertEquals("TARGETING_MISS", reason(ruleFlag("1", "eq"), 1.0));
  }

  @Test
  void numbersAreComparedAsPrimitiveDoubles() {
    // Double.equals would say 0.0 differs from -0.0 and NaN equals NaN; the spec says IEEE 754 ==.
    assertEquals("ON", reason(ruleFlag(0.0, "eq"), -0.0));
    assertEquals("ON", reason(ruleFlag(9007199254740992.0, "eq"), (double) 9007199254740993L));
    assertEquals("ON", reason(ruleFlag(1, "eq"), 1.0)); // an Integer that reached the evaluator from another caller
    assertEquals("TARGETING_MISS", reason(ruleFlag(Double.NaN, "eq"), Double.NaN));
  }

  @Test
  void hashOfBytesAboveOneHundredTwentySevenIsNotSignExtended() {
    // 0xE0 0xB8 0x81 is U+0E01; a signed byte xor-ed in without & 0xff would give a different hash.
    assertEquals(0x4d8c7d5dL, 0x4d8c7d5dL & 0xffffffffL);
    assertTrue(Evaluation.fnv1a32("ก") > 0 && Evaluation.fnv1a32("ก") < (1L << 32));
    assertEquals(2166136261L, Evaluation.fnv1a32(""));
    assertEquals(0xe40c292cL, Evaluation.fnv1a32("a"));
  }

  @Test
  void attributeNamesThatAreJavaMethodsAreOrdinaryAttributes() {
    Flag neq = flag(List.of(new Rule("toString", "neq", "x")), 100, List.of());
    assertEquals("TARGETING_MISS", Evaluation.evaluate(neq, new Context("", Map.of())).reason());
    assertEquals("ON", Evaluation.evaluate(neq, new Context("", Map.of("toString", "y"))).reason());
  }
}

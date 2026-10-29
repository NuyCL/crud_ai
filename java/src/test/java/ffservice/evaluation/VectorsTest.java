package ffservice.evaluation;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ffservice.TestSupport;
import ffservice.model.Context;
import ffservice.model.EvaluationResult;
import ffservice.model.Flag;
import ffservice.model.Rule;
import ffservice.model.Scalars;
import ffservice.model.Variant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

/** The vectors shared with every other language (tests/vectors). They are the arbiter, not these tests. */
class VectorsTest {
  @Test
  void theVectorFilesAreNotEmpty() {
    assertFalse(TestSupport.cases("fnv1a32.json").isEmpty());
    assertFalse(TestSupport.cases("bucketing.json").isEmpty());
    assertFalse(TestSupport.cases("evaluation.json").isEmpty());
    assertFalse(TestSupport.cases("erfc.json").isEmpty());
  }

  @TestFactory
  Stream<DynamicTest> fnv1a32() {
    return TestSupport.cases("fnv1a32.json").stream().map(c -> DynamicTest.dynamicTest(
        "fnv1a32(" + c.get("input") + ")",
        () -> assertEquals(((Number) c.get("hash")).longValue(), Evaluation.fnv1a32((String) c.get("input")))));
  }

  @Test
  void everyRowOfBucketing() {
    for (Map<String, Object> c : TestSupport.cases("bucketing.json")) {
      String input = (String) c.get("input");
      assertEquals(((Number) c.get("hash")).longValue(), Evaluation.fnv1a32(input), "hash of " + input);
      assertEquals(((Number) c.get("bucket")).intValue(),
          Evaluation.bucket((String) c.get("flagKey"), (String) c.get("salt"), (String) c.get("userId")),
          "bucket of " + input);
    }
  }

  @TestFactory
  Stream<DynamicTest> evaluation() {
    return TestSupport.cases("evaluation.json").stream().map(c -> DynamicTest.dynamicTest((String) c.get("id"), () -> {
      @SuppressWarnings("unchecked")
      Map<String, Object> expected = (Map<String, Object>) c.get("expected");
      EvaluationResult want = new EvaluationResult(
          (Boolean) expected.get("enabled"), (String) expected.get("variant"), (String) expected.get("reason"));
      assertEquals(want, Evaluation.evaluate(flag(c.get("flag")), context(c.get("context"))));
    }));
  }

  @Test
  @SuppressWarnings("unchecked")
  void erfcMatchesEveryRowWithinTheStatedTolerances() {
    Map<String, Object> file = TestSupport.vectors("erfc.json");
    double absolute = ((Number) file.get("absoluteTolerance")).doubleValue();
    double relative = ((Number) file.get("relativeTolerance")).doubleValue();
    List<Map<String, Object>> cases = (List<Map<String, Object>>) file.get("cases");
    assertTrue(cases.size() > 0);
    for (Map<String, Object> c : cases) {
      double x = ((Number) c.get("x")).doubleValue();
      double want = ((Number) c.get("erfc")).doubleValue();
      double tolerance = Math.max(absolute, relative * want);
      assertTrue(Math.abs(ffservice.service.ErfcAccess.erfc(x) - want) <= tolerance, "erfc(" + x + ")");
    }
  }

  @SuppressWarnings("unchecked")
  private static Flag flag(Object raw) {
    if (raw == null) {
      return null;
    }
    Map<String, Object> d = (Map<String, Object>) raw;
    List<Rule> rules = new ArrayList<>();
    for (Map<String, Object> r : (List<Map<String, Object>>) d.getOrDefault("rules", List.of())) {
      Object value = r.get("value");
      Object scalar = value instanceof List<?> list ? list.stream().map(Scalars::of).toList() : Scalars.of(value);
      rules.add(new Rule((String) r.get("attribute"), (String) r.get("operator"), scalar));
    }
    List<Variant> variants = new ArrayList<>();
    for (Map<String, Object> v : (List<Map<String, Object>>) d.getOrDefault("variants", List.of())) {
      variants.add(new Variant((String) v.get("key"), Scalars.asInt(v.get("weight"))));
    }
    return new Flag((String) d.get("key"), (String) d.getOrDefault("description", ""), (Boolean) d.get("enabled"),
        rules, Scalars.asInt(d.get("rolloutPercent")), variants, null, null);
  }

  @SuppressWarnings("unchecked")
  private static Context context(Object raw) {
    Map<String, Object> d = (Map<String, Object>) raw;
    Map<String, Object> attributes = new LinkedHashMap<>();
    Map<String, Object> given = (Map<String, Object>) d.get("attributes");
    if (given != null) {
      given.forEach((k, v) -> attributes.put(k, Scalars.of(v)));
    }
    return new Context((String) d.getOrDefault("userId", ""), attributes);
  }
}

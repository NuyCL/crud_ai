package ffservice.service;

import static ffservice.TestSupport.json;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ffservice.model.Event;
import ffservice.model.Flag;
import java.util.List;
import java.util.Map;
import java.util.function.Supplier;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.ValueSource;

/** Validation (BR-01, BR-04, BR-08, BR-20, BR-30..35, BR-43, BR-50) at the parser level. */
class ParseTest {
  /** The error code a parser call ends with, or "" if it accepts. */
  private static String code(Supplier<?> parse) {
    try {
      parse.get();
      return "";
    } catch (ServiceError e) {
      return e.code().name();
    }
  }

  private static String flagCode(String text) {
    return code(() -> Parse.flagInput(json(text)));
  }

  @ParameterizedTest
  @ValueSource(strings = {"a", "0", "a-b_c", "9z", "a-", "a_"})
  void br01ValidKeys(String key) {
    assertEquals("", flagCode("{\"key\":" + ffservice.model.Json.stringify(key) + "}"), key);
  }

  @ParameterizedTest
  @ValueSource(strings = {
      "caf\u00e9", "\u0e01", "-a", "_a", "A", "aB", "Ab", "a-B", "a b", "a.b", "a/b", "a\n", "\n", "a\u0000", "\u0663", "", " "})
  void br01InvalidKeys(String key) {
    // "a\n" is accepted by a regex that ends in `$`; "\u0663" (Arabic-Indic three) by one that uses \d
    assertEquals("INVALID_KEY", flagCode("{\"key\":" + ffservice.model.Json.stringify(key) + "}"), key);
  }

  @Test
  void br01KeyLengthBoundary() {
    assertEquals("", flagCode("{\"key\":\"" + "a".repeat(64) + "\"}"));
    assertEquals("INVALID_KEY", flagCode("{\"key\":\"" + "a".repeat(65) + "\"}"));
  }

  @Test
  void br01KeyMustBeAString() {
    for (String text : List.of("{}", "{\"key\":1}", "{\"key\":null}", "{\"key\":[\"a\"]}", "{\"key\":true}")) {
      assertEquals("VALIDATION_ERROR", flagCode(text), text);
    }
  }

  @Test
  void bodyMustBeAnObject() {
    for (String text : List.of("[]", "1", "\"a\"", "null", "true")) {
      assertEquals("VALIDATION_ERROR", flagCode(text), text);
    }
  }

  @Test
  void br08Defaults() {
    Flag f = Parse.flagInput(json("{\"key\":\"k\"}"));
    assertEquals("", f.description());
    assertFalse(f.enabled());
    assertEquals(100, f.rolloutPercent());
    assertTrue(f.rules().isEmpty() && f.variants().isEmpty());
  }

  @Test
  void br04DescriptionCountsCodePoints() {
    String grin = "\\ud83d\\ude00";
    assertEquals("", flagCode("{\"key\":\"k\",\"description\":\"" + "x".repeat(500) + "\"}"));
    assertEquals("VALIDATION_ERROR", flagCode("{\"key\":\"k\",\"description\":\"" + "x".repeat(501) + "\"}"));
    assertEquals("", flagCode("{\"key\":\"k\",\"description\":\"" + grin.repeat(500) + "\"}")); // 1000 UTF-16 units
    assertEquals("VALIDATION_ERROR", flagCode("{\"key\":\"k\",\"description\":\"" + grin.repeat(501) + "\"}"));
  }

  @ParameterizedTest
  @ValueSource(strings = {
      "{\"key\":\"k\",\"description\":1}", "{\"key\":\"k\",\"description\":null}", "{\"key\":\"k\",\"enabled\":\"true\"}",
      "{\"key\":\"k\",\"enabled\":1}", "{\"key\":\"k\",\"enabled\":null}", "{\"key\":\"k\",\"rules\":{}}",
      "{\"key\":\"k\",\"rules\":null}", "{\"key\":\"k\",\"variants\":null}", "{\"key\":\"k\",\"rolloutPercent\":null}"})
  void br04WrongTypesAreRejected(String text) {
    assertEquals("VALIDATION_ERROR", flagCode(text));
  }

  @ParameterizedTest
  @CsvSource({
      "0,true", "100,true", "50,true", "10.0,true", "1e1,true", "1E1,true", "1e+1,true", "-0,true", "-0.0,true",
      "5.0E0,true", "101,false", "-1,false", "10.5,false", "1e999,false", "1e3,false", "\"10\",false", "true,false",
      "null,false", "[10],false", "1e-1,false", "100.0000001,false", "99999999999999999999999999,false"})
  void br30RolloutPercent(String literal, boolean ok) {
    assertEquals(ok ? "" : "VALIDATION_ERROR", flagCode("{\"key\":\"k\",\"rolloutPercent\":" + literal + "}"), literal);
  }

  @Test
  void br30RolloutPercentNumbersThatAreTooLongOrTooBigAreRejectedNotCrashed() {
    // Jackson itself limits a number to 1000 characters; either way it is a 400 at the HTTP level (see ApiTest)
    assertEquals("VALIDATION_ERROR", flagCode("{\"key\":\"k\",\"rolloutPercent\":1" + "0".repeat(900) + "}"));
  }

  private static String variantsCode(String items) {
    return flagCode("{\"key\":\"k\",\"variants\":" + items + "}");
  }

  @Test
  void br31ToBr34Variants() {
    String a = "{\"key\":\"a\",\"weight\":50}";
    String b = "{\"key\":\"b\",\"weight\":50}";
    assertEquals("", variantsCode("[]"));
    assertEquals("", variantsCode("[" + a + "," + b + "]"));
    assertEquals("INVALID_VARIANTS", variantsCode("[" + a + "]"));
    assertEquals("INVALID_VARIANTS", variantsCode("[{\"key\":\"a\",\"weight\":100}]")); // one variant is no experiment
    assertEquals("INVALID_VARIANTS", variantsCode("[" + a + ",{\"key\":\"b\",\"weight\":49}]"));
    assertEquals("INVALID_VARIANTS", variantsCode("[" + a + ",{\"key\":\"a\",\"weight\":50}]"));
    assertEquals("INVALID_VARIANTS", variantsCode("[" + a + ",{\"key\":\"b\",\"weight\":0}]"));
    assertEquals("INVALID_VARIANTS", variantsCode("[" + a + ",{\"key\":\"b\",\"weight\":50.5}]"));
    assertEquals("INVALID_VARIANTS", variantsCode("[" + a + ",{\"key\":\"b\",\"weight\":true}]"));
    assertEquals("INVALID_VARIANTS", variantsCode("[" + a + ",{\"key\":\"B\",\"weight\":50}]"));
    assertEquals("INVALID_VARIANTS", variantsCode("[" + a + ",{\"key\":\"" + "b".repeat(33) + "\",\"weight\":50}]"));
    assertEquals("", variantsCode("[" + a + ",{\"key\":\"" + "b".repeat(32) + "\",\"weight\":50}]"));
    assertEquals("", variantsCode("[" + a + ",{\"key\":\"b\",\"weight\":50.0}]"));
    assertEquals("VALIDATION_ERROR", variantsCode("{}"));
    String many = String.join(",", java.util.stream.IntStream.range(0, 10)
        .mapToObj(i -> "{\"key\":\"v" + i + "\",\"weight\":10}").toList());
    assertEquals("", variantsCode("[" + many + "]"));
    assertEquals("INVALID_VARIANTS", variantsCode("[" + many + ",{\"key\":\"x\",\"weight\":1}]"));
    // 11 variants whose weights do add up to 100: only the count can reject them
    String eleven = String.join(",", java.util.stream.IntStream.range(0, 11)
        .mapToObj(i -> "{\"key\":\"v" + i + "\",\"weight\":" + (i == 0 ? 10 : 9) + "}").toList());
    assertEquals("INVALID_VARIANTS", variantsCode("[" + eleven + "]"));
    assertEquals("INVALID_VARIANTS", variantsCode("[" + a + ",[]," + b + "]"));
  }

  @Test
  void br33VariantOrderIsKept() {
    Flag f = Parse.flagInput(json("{\"key\":\"k\",\"variants\":[{\"key\":\"z\",\"weight\":10},{\"key\":\"a\",\"weight\":90}]}"));
    assertEquals(List.of("z", "a"), f.variants().stream().map(v -> v.key()).toList());
  }

  private static String ruleCode(String rule) {
    return flagCode("{\"key\":\"k\",\"rules\":[" + rule + "]}");
  }

  @Test
  void br35Rules() {
    assertEquals("", ruleCode("{\"attribute\":\"a\",\"operator\":\"eq\",\"value\":\"x\"}"));
    assertEquals("", ruleCode("{\"attribute\":\"a\",\"operator\":\"neq\",\"value\":1.5}"));
    assertEquals("", ruleCode("{\"attribute\":\"a\",\"operator\":\"eq\",\"value\":true}"));
    assertEquals("", ruleCode("{\"attribute\":\"a\",\"operator\":\"in\",\"value\":[\"x\",1,false]}"));
    assertEquals("", ruleCode("{\"attribute\":\"a\",\"operator\":\"not_in\",\"value\":[\"x\"]}"));
    for (String bad : List.of(
        "{\"attribute\":\"\",\"operator\":\"eq\",\"value\":\"x\"}", "{\"attribute\":1,\"operator\":\"eq\",\"value\":\"x\"}",
        "{\"operator\":\"eq\",\"value\":\"x\"}", "{\"attribute\":\"a\",\"operator\":\"gt\",\"value\":1}",
        "{\"attribute\":\"a\",\"operator\":[\"eq\"],\"value\":1}", "{\"attribute\":\"a\",\"operator\":\"eq\"}",
        "{\"attribute\":\"a\",\"operator\":\"eq\",\"value\":null}", "{\"attribute\":\"a\",\"operator\":\"eq\",\"value\":[\"x\"]}",
        "{\"attribute\":\"a\",\"operator\":\"eq\",\"value\":{}}", "{\"attribute\":\"a\",\"operator\":\"in\",\"value\":\"x\"}",
        "{\"attribute\":\"a\",\"operator\":\"in\",\"value\":[]}", "{\"attribute\":\"a\",\"operator\":\"in\",\"value\":[null]}",
        "{\"attribute\":\"a\",\"operator\":\"in\",\"value\":[[1]]}", "{\"attribute\":\"a\",\"operator\":\"eq\",\"value\":1e999}",
        "1", "[]", "null")) {
      assertEquals("VALIDATION_ERROR", ruleCode(bad), bad);
    }
  }

  @Test
  void ruleValuesBecomeDoublesAndBooleansStayBooleans() {
    Flag f = Parse.flagInput(json(
        "{\"key\":\"k\",\"rules\":[{\"attribute\":\"a\",\"operator\":\"in\",\"value\":[1,2.5,true,\"s\"]}]}"));
    assertEquals(List.of(1.0, 2.5, true, "s"), f.rules().get(0).value());
  }

  @Test
  void br20EvaluateRequest() {
    assertEquals("", code(() -> Parse.evaluateRequest(json("{}"))));
    assertEquals("", code(() -> Parse.evaluateRequest(json("{\"flags\":[]}"))));
    for (String bad : List.of("[]", "1", "null", "{\"flags\":\"a\"}", "{\"flags\":[1]}", "{\"flags\":null}",
        "{\"context\":[]}", "{\"context\":{\"userId\":1}}", "{\"context\":{\"attributes\":[]}}",
        "{\"context\":{\"attributes\":{\"a\":null}}}", "{\"context\":{\"attributes\":{\"a\":[1]}}}",
        "{\"context\":{\"attributes\":{\"a\":{}}}}")) {
      assertEquals("VALIDATION_ERROR", code(() -> Parse.evaluateRequest(json(bad))), bad);
    }
  }

  @Test
  void br23FlagsAbsentIsNotFlagsEmpty() {
    assertEquals(null, Parse.evaluateRequest(json("{}")).flags());
    assertEquals(List.of(), Parse.evaluateRequest(json("{\"flags\":[]}")).flags());
  }

  @Test
  void br43Events() {
    String ok = "{\"type\":\"conversion\",\"userId\":\"u\",\"goal\":\"g\"}";
    assertEquals("", code(() -> Parse.events(json("{\"events\":[" + ok + "]}"))));
    assertEquals("", code(() -> Parse.events(json(
        "{\"events\":[{\"type\":\"exposure\",\"userId\":\"u\",\"flagKey\":\"f\",\"variant\":\"a\"}]}"))));
    assertEquals("", code(() -> Parse.events(json("{\"events\":[" + String.join(",", java.util.Collections.nCopies(100, ok)) + "]}"))));
    for (String bad : List.of(
        "{}", "[]", "{\"events\":[]}", "{\"events\":[" + String.join(",", java.util.Collections.nCopies(101, ok)) + "]}",
        "{\"events\":\"x\"}", "{\"events\":[1]}", "{\"events\":[{}]}",
        "{\"events\":[{\"type\":\"click\",\"userId\":\"u\",\"goal\":\"g\"}]}",
        "{\"events\":[{\"type\":[\"conversion\"],\"userId\":\"u\",\"goal\":\"g\"}]}",
        "{\"events\":[{\"type\":\"conversion\",\"userId\":\"\",\"goal\":\"g\"}]}",
        "{\"events\":[{\"type\":\"conversion\",\"userId\":1,\"goal\":\"g\"}]}",
        "{\"events\":[{\"type\":\"conversion\",\"userId\":\"u\",\"goal\":\"\"}]}",
        "{\"events\":[{\"type\":\"conversion\",\"userId\":\"u\"}]}",
        "{\"events\":[{\"type\":\"exposure\",\"userId\":\"u\",\"variant\":\"a\"}]}",
        "{\"events\":[{\"type\":\"exposure\",\"userId\":\"u\",\"flagKey\":\"f\"}]}",
        "{\"events\":[{\"type\":\"conversion\",\"userId\":\"u\",\"goal\":\"g\",\"timestamp\":1}]}",
        "{\"events\":[{\"type\":\"conversion\",\"userId\":\"u\",\"goal\":\"g\",\"timestamp\":null}]}",
        "{\"events\":[" + ok + ",{\"type\":\"conversion\",\"userId\":\"u\",\"goal\":\"\"}]}")) {
      assertEquals("VALIDATION_ERROR", code(() -> Parse.events(json(bad))), bad.length() > 80 ? bad.substring(0, 80) : bad);
    }
    List<Event> events = Parse.events(json("{\"events\":[" + ok + "]}"));
    assertEquals(new Event("conversion", "u", "", "", "g"), events.get(0));
  }

  @ParameterizedTest
  @CsvSource(delimiter = '|', value = {
      "2026-01-31T08:00:00Z|true", "2026-01-31T15:00:00.250+07:00|true", "2026-01-31T08:00:00.1234567890Z|true",
      "2028-02-29T00:00:00Z|true", "2000-02-29T00:00:00Z|true", "2026-12-31T23:59:59-23:59|true",
      "2026-02-30T00:00:00Z|false", "2027-02-29T00:00:00Z|false", "1900-02-29T00:00:00Z|false",
      "2026-04-31T00:00:00Z|false", "2026-13-01T00:00:00Z|false", "2026-00-10T00:00:00Z|false",
      "2026-01-00T00:00:00Z|false", "2026-01-31T24:00:00Z|false", "2026-01-31T00:60:00Z|false",
      "2026-01-31T00:00:60Z|false", "2026-01-31|false", "2026-01-31T08:00:00|false", "2026-01-31T8:00:00Z|false",
      "2026-01-31T08:00:00,5Z|false", "2026-01-31T08:00:00+0700|false", "2026-01-31T08:00:00+24:00|false",
      "2026-01-31T08:00:00+07:60|false", "2026-01-31t08:00:00Z|false", "2026-01-31T08:00:00z|false",
      "2026-01-31 08:00:00Z|false", "2026-01-31T08:00:00.Z|false", "20260131T080000Z|false", "26-01-31T08:00:00Z|false"})
  void br43Timestamps(String stamp, boolean ok) {
    assertEquals(ok, Parse.validTimestamp(stamp), stamp);
  }

  @Test
  void br43TimestampsWithLineBreaksSpacesAndLookAlikeDigitsAreRejected() {
    for (String stamp : List.of("2026-01-31T08:00:00Z\n", " 2026-01-31T08:00:00Z", "", "\u0662\u0660\u0662\u0666-01-31T08:00:00Z",
        "\uff12\uff10\uff12\uff16-01-31T08:00:00Z")) {
      assertFalse(Parse.validTimestamp(stamp), stamp);
    }
  }

  private static Parse.Page page(Map<String, List<String>> query) {
    return Parse.page(query);
  }

  @Test
  void br50Paging() {
    assertEquals(new Parse.Page(20, 0), page(Map.of()));
    assertEquals(new Parse.Page(1, 0), page(Map.of("limit", List.of("1"))));
    assertEquals(new Parse.Page(100, 5), page(Map.of("limit", List.of("100"), "offset", List.of("5"))));
    assertEquals(new Parse.Page(5, 0), page(Map.of("limit", List.of("5", "999")))); // the first value counts
    assertEquals(new Parse.Page(20, Integer.MAX_VALUE), page(Map.of("offset", List.of("2147483647"))));
    for (Map<String, List<String>> query : List.of(
        Map.of("limit", List.of("0")), Map.of("limit", List.of("101")), Map.of("limit", List.of("-1")),
        Map.of("limit", List.of("1.5")), Map.of("limit", List.of("abc")), Map.of("limit", List.of("")),
        Map.of("limit", List.of("+1")), Map.of("limit", List.of("1e1")), Map.of("limit", List.of(" 1")),
        Map.of("limit", List.of("\u0661")), Map.of("limit", List.of("999", "5")), Map.of("offset", List.of("-1")),
        Map.of("offset", List.of("2147483648")), Map.of("offset", List.of("9".repeat(4000))), Map.of("offset", List.of("")))) {
      assertThrows(ServiceError.class, () -> page(query), query.toString().substring(0, Math.min(60, query.toString().length())));
    }
  }

  @Test
  void cleanReplacesLoneSurrogatesEverywhereAndKeepsPairs() {
    Object cleaned = Parse.clean(json("{\"a\\ud800\":[\"\\udc00x\",\"\\ud83d\\ude00\",{\"k\":\"\\ud83d\"}],\"n\":1,\"t\":true}"));
    assertEquals("{a\ufffd=[\ufffdx, \ud83d\ude00, {k=\ufffd}], n=1, t=true}", cleaned.toString());
  }
}

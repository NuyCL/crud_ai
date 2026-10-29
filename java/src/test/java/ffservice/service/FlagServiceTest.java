package ffservice.service;

import static ffservice.TestSupport.json;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ffservice.TestSupport;
import ffservice.model.AuditLog;
import ffservice.model.Flag;
import ffservice.model.Json;
import ffservice.model.VariantResult;
import ffservice.repository.Repository;
import ffservice.repository.SqliteRepository;
import ffservice.repository.Tx;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

/** Business rules through the service, on a real in-memory SQLite repository. */
class FlagServiceTest {
  private static final String TWO_ARMS = "\"variants\":[{\"key\":\"control\",\"weight\":50},{\"key\":\"treatment\",\"weight\":50}]";

  private SqliteRepository repo;
  private FlagService svc;

  @BeforeEach
  void open() {
    repo = new SqliteRepository(":memory:");
    svc = TestSupport.service(repo);
  }

  @AfterEach
  void close() {
    repo.close();
  }

  private Flag create(String body) {
    return svc.createFlag(json(body));
  }

  private static String code(Runnable call) {
    try {
      call.run();
      return "";
    } catch (ServiceError e) {
      return e.code().name();
    }
  }

  private List<String> auditActions() {
    List<AuditLog> logs = svc.listAudit(null, 100, 0).items();
    List<String> out = new ArrayList<>();
    for (int i = logs.size() - 1; i >= 0; i--) {
      out.add(logs.get(i).flagKey() + ":" + logs.get(i).action());
    }
    return out;
  }

  private Map<String, String> reasons(String body) {
    Map<String, String> out = new java.util.LinkedHashMap<>();
    svc.evaluate(json(body)).forEach((k, v) -> out.put(k, v.reason()));
    return out;
  }

  @Test
  void br02DuplicateKeyIsRejectedAndNothingIsAudited() {
    create("{\"key\":\"f\",\"description\":\"first\"}");
    assertEquals("FLAG_EXISTS", code(() -> create("{\"key\":\"f\",\"description\":\"second\"}")));
    assertEquals("first", svc.getFlag("f").description());
    assertEquals(List.of("f:create"), auditActions());
  }

  @Test
  void br04TextSurvivesAStoreAndLoadByteForByte() {
    String text = "café ไทย 😀 \u0000 \"q\" \\ \n";
    svc.createFlag(json("{\"key\":\"f\",\"description\":" + Json.stringify(text) + "}"));
    assertEquals(text, svc.getFlag("f").description());
  }

  @Test
  void br05UnknownFlagIsNotFound() {
    assertEquals("FLAG_NOT_FOUND", code(() -> svc.getFlag("ghost")));
    assertEquals("FLAG_NOT_FOUND", code(() -> svc.updateFlag("ghost", json("{\"key\":\"ghost\"}"))));
    assertEquals("FLAG_NOT_FOUND", code(() -> svc.deleteFlag("ghost")));
  }

  @Test
  void br09UpdateIsAFullReplaceAndKeepsCreatedAt() {
    Flag created = create("{\"key\":\"f\",\"description\":\"d\",\"enabled\":true,\"rolloutPercent\":10,"
        + "\"rules\":[{\"attribute\":\"a\",\"operator\":\"eq\",\"value\":1}]}");
    Flag updated = svc.updateFlag("f", json("{\"key\":\"f\",\"enabled\":false}"));
    assertEquals("", updated.description());
    assertFalse(updated.enabled());
    assertEquals(100, updated.rolloutPercent());
    assertTrue(updated.rules().isEmpty() && updated.variants().isEmpty());
    assertEquals(created.createdAt(), updated.createdAt());
    assertTrue(updated.updatedAt().isAfter(created.updatedAt()));
    assertEquals(updated, svc.getFlag("f"));
  }

  @Test
  void br09UpdatedAtNeverGoesBackwards() {
    Instant[] ticks = {Instant.parse("2026-01-31T08:00:10Z"), Instant.parse("2026-01-31T08:00:05Z")};
    int[] next = {0};
    FlagService backwards = new FlagService(repo, () -> ticks[next[0]++]);
    Flag created = backwards.createFlag(json("{\"key\":\"f\"}"));
    Flag updated = backwards.updateFlag("f", json("{\"key\":\"f\"}"));
    assertEquals(created.updatedAt(), updated.updatedAt());
  }

  @Test
  void br03KeyCannotChangeAndNothingIsWritten() {
    create("{\"key\":\"f\"}");
    assertEquals("KEY_IMMUTABLE", code(() -> svc.updateFlag("f", json("{\"key\":\"g\"}"))));
    assertEquals(List.of("f:create"), auditActions());
    assertEquals("FLAG_NOT_FOUND", code(() -> svc.getFlag("g")));
  }

  @Test
  void br51ValidationComesBeforeExistenceChecks() {
    assertEquals("INVALID_KEY", code(() -> svc.updateFlag("ghost", json("{\"key\":\"BAD\"}"))));
    assertEquals("KEY_IMMUTABLE", code(() -> svc.updateFlag("ghost", json("{\"key\":\"other\"}"))));
    assertEquals("VALIDATION_ERROR",
        code(() -> svc.updateFlag("ghost", json("{\"key\":\"ghost\",\"rolloutPercent\":101}"))));
  }

  @Test
  void br06DeleteRemovesTheFlagAndAllowsReuseOfTheKey() {
    create("{\"key\":\"f\",\"description\":\"one\"}");
    svc.deleteFlag("f");
    assertEquals("FLAG_NOT_FOUND", code(() -> svc.getFlag("f")));
    create("{\"key\":\"f\",\"description\":\"two\"}");
    assertEquals("two", svc.getFlag("f").description());
  }

  @Test
  void br21EvaluatingADeletedFlagReportsFlagNotFound() {
    create("{\"key\":\"f\",\"enabled\":true}");
    assertEquals("ON", reasons("{\"flags\":[\"f\"]}").get("f"));
    svc.deleteFlag("f");
    assertEquals("FLAG_NOT_FOUND", reasons("{\"flags\":[\"f\"]}").get("f"));
  }

  @Test
  @SuppressWarnings("unchecked")
  void br07EachChangeWritesOneAuditEntryWithBeforeAndAfter() throws Exception {
    create("{\"key\":\"f\",\"description\":\"v1\"}");
    svc.updateFlag("f", json("{\"key\":\"f\",\"description\":\"v2\"}"));
    svc.deleteFlag("f");
    List<AuditLog> logs = svc.listAudit("f", 10, 0).items();
    assertEquals(3, logs.size());
    AuditLog delete = logs.get(0);
    AuditLog update = logs.get(1);
    AuditLog creation = logs.get(2);
    assertEquals("create", creation.action());
    assertNull(creation.before());
    assertEquals("v1", ((Map<String, Object>) json(creation.after())).get("description"));
    assertEquals("v1", ((Map<String, Object>) json(update.before())).get("description"));
    assertEquals("v2", ((Map<String, Object>) json(update.after())).get("description"));
    assertEquals("delete", delete.action());
    assertNull(delete.after());
    assertEquals("v2", ((Map<String, Object>) json(delete.before())).get("description"));
    assertEquals(java.util.Set.of("key", "description", "enabled", "rules", "rolloutPercent", "variants", "createdAt",
        "updatedAt"), ((Map<String, Object>) json(creation.after())).keySet());
  }

  @Test
  void br07RejectedChangesAreNotAudited() {
    create("{\"key\":\"f\"}");
    assertEquals("FLAG_EXISTS", code(() -> create("{\"key\":\"f\"}")));
    assertEquals("INVALID_KEY", code(() -> create("{\"key\":\"BAD\"}")));
    assertEquals("KEY_IMMUTABLE", code(() -> svc.updateFlag("f", json("{\"key\":\"g\"}"))));
    assertEquals("FLAG_NOT_FOUND", code(() -> svc.deleteFlag("ghost")));
    assertEquals(List.of("f:create"), auditActions());
  }

  @Test
  void aFailureInsideTheTransactionLeavesNoFlagBehind() {
    Repository failing = new Repository() {
      @Override
      public void inTransaction(Consumer<Tx> work) {
        repo.inTransaction(tx -> work.accept(new Tx() {
          @Override
          public Flag getFlag(String key) {
            return tx.getFlag(key);
          }

          @Override
          public void insertFlag(Flag flag) {
            tx.insertFlag(flag);
          }

          @Override
          public void updateFlag(Flag flag) {
            tx.updateFlag(flag);
          }

          @Override
          public void deleteFlag(String key) {
            tx.deleteFlag(key);
          }

          @Override
          public void appendAudit(AuditLog entry) {
            throw new IllegalStateException("disk full");
          }
        }));
      }

      @Override
      public Flag getFlag(String key) {
        return repo.getFlag(key);
      }

      @Override
      public Page<Flag> listFlags(int limit, int offset) {
        return repo.listFlags(limit, offset);
      }

      @Override
      public List<Flag> listAllFlags() {
        return repo.listAllFlags();
      }

      @Override
      public Page<AuditLog> listAudit(String flagKey, int limit, int offset) {
        return repo.listAudit(flagKey, limit, offset);
      }

      @Override
      public void recordEvents(List<ffservice.model.Event> events) {
        repo.recordEvents(events);
      }

      @Override
      public Counts variantCounts(String flagKey, String goal) {
        return repo.variantCounts(flagKey, goal);
      }

      @Override
      public void close() {
      }
    };
    FlagService broken = new FlagService(failing, TestSupport.clock());
    assertThrows(IllegalStateException.class, () -> broken.createFlag(json("{\"key\":\"f\"}")));
    assertEquals("FLAG_NOT_FOUND", code(() -> svc.getFlag("f")));
    assertEquals(0, svc.listAudit(null, 10, 0).total());
  }

  @Test
  void br23FlagsSelectsWhatIsEvaluated() {
    create("{\"key\":\"a\",\"enabled\":true}");
    create("{\"key\":\"b\",\"enabled\":false}");
    assertEquals(java.util.Set.of("a", "b"), reasons("{}").keySet());
    assertEquals(Map.of(), reasons("{\"flags\":[]}"));
    assertEquals(java.util.Set.of("a", "ghost"), reasons("{\"flags\":[\"a\",\"ghost\",\"a\"]}").keySet());
    assertEquals("FLAG_NOT_FOUND", reasons("{\"flags\":[\"ghost\"]}").get("ghost"));
    assertEquals("DISABLED", reasons("{}").get("b"));
  }

  @Test
  void br22EvaluateWritesNothing() {
    create("{\"key\":\"f\",\"enabled\":true," + TWO_ARMS + "}");
    var before = List.of(svc.listFlags(10, 0), svc.listAudit(null, 10, 0), svc.results("f", "g"));
    for (int i = 0; i < 20; i++) {
      svc.evaluate(json("{\"flags\":[\"f\"],\"context\":{\"userId\":\"u" + i + "\"}}"));
    }
    assertEquals(before, List.of(svc.listFlags(10, 0), svc.listAudit(null, 10, 0), svc.results("f", "g")));
  }

  @Test
  void br44ABatchWithOneBadEventStoresNothing() {
    create("{\"key\":\"f\",\"enabled\":true," + TWO_ARMS + "}");
    String good = "{\"type\":\"exposure\",\"userId\":\"u\",\"flagKey\":\"f\",\"variant\":\"control\"}";
    assertEquals("VALIDATION_ERROR", code(() -> svc.recordEvents(json("{\"events\":[" + good + ",{\"type\":\"oops\"}]}"))));
    assertEquals(0, svc.results("f", "g").variants().get(0).exposures());
    assertEquals(1, svc.recordEvents(json("{\"events\":[" + good + "]}")));
    assertEquals(1, svc.results("f", "g").variants().get(0).exposures());
  }

  @Test
  void br46ResultsErrorsAndShape() {
    assertEquals("FLAG_NOT_FOUND", code(() -> svc.results("ghost", "g")));
    assertEquals("VALIDATION_ERROR", code(() -> svc.results("ghost", ""))); // the goal is checked first
    create("{\"key\":\"plain\"}");
    assertTrue(svc.results("plain", "g").variants().isEmpty());
    create("{\"key\":\"f\"," + TWO_ARMS + "}");
    assertEquals(new VariantResult("control", 0, 0, 0.0, null, false), svc.results("f", "g").variants().get(0));
  }

  // ------------------------------------------------------------- experiments

  private void record(List<String>... groups) {
    List<String> events = new ArrayList<>();
    for (List<String> g : groups) {
      events.addAll(g);
    }
    for (int i = 0; i < events.size(); i += 100) { // a request holds at most 100 events (BR-43)
      svc.recordEvents(json("{\"events\":[" + String.join(",", events.subList(i, Math.min(i + 100, events.size()))) + "]}"));
    }
  }

  private static List<String> exposures(String flag, String prefix, String variant, int n) {
    return java.util.stream.IntStream.range(0, n).mapToObj(i -> "{\"type\":\"exposure\",\"userId\":\"" + prefix + i
        + "\",\"flagKey\":\"" + flag + "\",\"variant\":\"" + variant + "\"}").toList();
  }

  private static List<String> conversions(String goal, String prefix, int n) {
    return java.util.stream.IntStream.range(0, n).mapToObj(i -> "{\"type\":\"conversion\",\"userId\":\"" + prefix + i
        + "\",\"goal\":\"" + goal + "\"}").toList();
  }

  private void twoArmFlag(String key) {
    create("{\"key\":\"" + key + "\",\"enabled\":true," + TWO_ARMS + "}");
  }

  @Test
  @SuppressWarnings("unchecked")
  void br40Br41CountingRules() {
    twoArmFlag("f");
    record(exposures("f", "c", "control", 3), exposures("f", "c", "treatment", 3)); // same users again: first wins
    record(conversions("buy", "c", 2), conversions("buy", "c", 2), conversions("buy", "nobody", 5));
    var rows = svc.results("f", "buy").variants();
    assertEquals(3, rows.get(0).exposures());
    assertEquals(2, rows.get(0).conversions());
    assertEquals(0, rows.get(1).exposures());
    assertEquals(2.0 / 3, rows.get(0).rate(), 1e-12);
  }

  @Test
  void br42SmallSamplesReportNoPValue() {
    twoArmFlag("f");
    record(exposures("f", "c", "control", 29), exposures("f", "t", "treatment", 29), conversions("buy", "t", 29));
    assertTrue(svc.results("f", "buy").variants().stream().allMatch(r -> r.pValue() == null && !r.significant()));
    record(exposures("f", "x", "control", 1)); // control now has 30, treatment still 29
    assertNull(svc.results("f", "buy").variants().get(1).pValue());
    record(exposures("f", "y", "treatment", 1));
    assertTrue(svc.results("f", "buy").variants().get(1).pValue() != null);
  }

  @ParameterizedTest
  @CsvSource({"20,40,0.005101399646004991,true", "40,20,0.005101399646004991,true", "20,33,0.05521070303825936,false",
      "20,34,0.04051697280293331,true"})
  void br42TwoProportionZTestAndTheSignificanceThreshold(int controlConversions, int treatmentConversions, double p,
      boolean significant) {
    twoArmFlag("f");
    record(exposures("f", "c", "control", 200), exposures("f", "t", "treatment", 200),
        conversions("buy", "c", controlConversions), conversions("buy", "t", treatmentConversions));
    var rows = svc.results("f", "buy").variants();
    assertNull(rows.get(0).pValue());
    assertFalse(rows.get(0).significant());
    assertEquals(p, rows.get(1).pValue(), 1e-9); // pooled p = 0.15, se = 0.035707, z = 2.80056 for the first row
    assertEquals(significant, rows.get(1).significant());
  }

  @Test
  void br42IdenticalRatesAndNoVariationHaveNoSignificance() {
    twoArmFlag("same");
    record(exposures("same", "c", "control", 100), exposures("same", "t", "treatment", 100),
        conversions("buy", "c", 30), conversions("buy", "t", 30));
    var row = svc.results("same", "buy").variants().get(1);
    assertEquals(1.0, row.pValue(), 1e-12);
    assertFalse(row.significant());

    twoArmFlag("none");
    record(exposures("none", "c", "control", 40), exposures("none", "t", "treatment", 40));
    var none = svc.results("none", "never-converted").variants().get(1); // a goal no other experiment used
    assertNull(none.pValue());
    assertFalse(none.significant()); // standard error 0
  }

  @Test
  void listingPagesInKeyOrderWithTotal() {
    for (String key : List.of("c", "a", "b")) {
      create("{\"key\":\"" + key + "\"}");
    }
    var page = svc.listFlags(2, 1);
    assertEquals(List.of("b", "c"), page.items().stream().map(Flag::key).toList());
    assertEquals(3, page.total());
  }

  @Test
  void timestampsAreUtcRfc3339WithMilliseconds() {
    assertEquals("2026-01-31T08:00:01.000Z", create("{\"key\":\"f\"}").toJson().get("createdAt"));
  }
}

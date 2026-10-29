package ffservice.repository;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ffservice.model.AuditLog;
import ffservice.model.Event;
import ffservice.model.Flag;
import ffservice.model.Rule;
import ffservice.model.Variant;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class SqliteRepositoryTest {
  private static final Instant T0 = Instant.parse("2026-01-31T08:00:00.250Z");

  private SqliteRepository repo;

  @BeforeEach
  void open() {
    repo = new SqliteRepository(":memory:");
  }

  @AfterEach
  void close() {
    repo.close();
  }

  private static Flag make(String key) {
    return new Flag(key, "", false, List.of(), 100, List.of(), T0, T0);
  }

  private void put(SqliteRepository r, Flag flag) {
    r.inTransaction(tx -> tx.insertFlag(flag));
  }

  private static AuditLog audit(String key, String action, String before, String after) {
    return new AuditLog(0, key, action, before, after, T0);
  }

  @Test
  void insertThenGetRoundTripsEveryField() {
    Flag f = new Flag("f", "café ก 😀 \u0000 end", true,
        List.of(new Rule("country", "in", List.of("TH", 1.5, true)), new Rule("age", "neq", 18.0)), 37,
        List.of(new Variant("b", 30), new Variant("a", 70)), T0, T0);
    put(repo, f);
    assertEquals(f, repo.getFlag("f"));
  }

  @Test
  void emptyRulesAndVariantsComeBackAsEmptyLists() {
    put(repo, make("f"));
    assertTrue(repo.getFlag("f").rules().isEmpty());
    assertTrue(repo.getFlag("f").variants().isEmpty());
  }

  @Test
  void getUnknownFlagIsNotFound() {
    assertThrows(NotFoundException.class, () -> repo.getFlag("ghost"));
  }

  @Test
  void insertDuplicateKeyIsExistsAndKeepsTheOriginal() {
    put(repo, new Flag("f", "first", false, List.of(), 100, List.of(), T0, T0));
    assertThrows(ExistsException.class,
        () -> put(repo, new Flag("f", "second", false, List.of(), 100, List.of(), T0, T0)));
    assertEquals("first", repo.getFlag("f").description());
  }

  @Test
  void updateReplacesFieldsButKeepsCreatedAt() {
    put(repo, new Flag("f", "old", false, List.of(), 100, List.of(), T0, T0));
    Instant later = Instant.parse("2026-02-01T00:00:00Z");
    repo.inTransaction(tx -> tx.updateFlag(
        new Flag("f", "new", true, List.of(), 100, List.of(), Instant.parse("2000-01-01T00:00:00Z"), later)));
    Flag got = repo.getFlag("f");
    assertEquals("new", got.description());
    assertTrue(got.enabled());
    assertEquals(T0, got.createdAt());
    assertEquals(later, got.updatedAt());
  }

  @Test
  void updateAndDeleteOfUnknownFlagAreNotFound() {
    assertThrows(NotFoundException.class, () -> repo.inTransaction(tx -> tx.updateFlag(make("ghost"))));
    assertThrows(NotFoundException.class, () -> repo.inTransaction(tx -> tx.deleteFlag("ghost")));
  }

  @Test
  void deleteRemovesTheFlag() {
    put(repo, make("f"));
    repo.inTransaction(tx -> tx.deleteFlag("f"));
    assertThrows(NotFoundException.class, () -> repo.getFlag("f"));
  }

  @Test
  void listFlagsIsSortedByKeyAndPagedWithTotal() {
    for (String key : List.of("c", "a", "e", "b", "d")) {
      put(repo, make(key));
    }
    var page = repo.listFlags(2, 1);
    assertEquals(List.of("b", "c"), page.items().stream().map(Flag::key).toList());
    assertEquals(5, page.total());
    var past = repo.listFlags(10, 5);
    assertTrue(past.items().isEmpty());
    assertEquals(5, past.total());
    assertEquals(List.of("a", "b", "c", "d", "e"), repo.listAllFlags().stream().map(Flag::key).toList());
  }

  @Test
  void aFailedTransactionRollsBackFlagAndAuditTogether() {
    assertThrows(IllegalStateException.class, () -> repo.inTransaction(tx -> {
      tx.insertFlag(make("f"));
      tx.appendAudit(audit("f", "create", null, "{}"));
      throw new IllegalStateException("boom");
    }));
    assertThrows(NotFoundException.class, () -> repo.getFlag("f"));
    assertEquals(0, repo.listAudit(null, 10, 0).total());
  }

  @Test
  void aTransactionThatThrowsAnErrorDoesNotStrandTheConnection() {
    for (int i = 0; i < 3; i++) {
      assertThrows(AssertionError.class, () -> repo.inTransaction(tx -> {
        tx.insertFlag(make("f"));
        throw new AssertionError("an Error, not an Exception");
      }));
    }
    put(repo, make("f")); // would fail if the connection were still inside the previous transaction
    assertEquals("f", repo.getFlag("f").key());
  }

  @Test
  void auditIsNewestFirstFilteredAndKeepsNullBeforeAndAfter() {
    repo.inTransaction(tx -> {
      tx.appendAudit(audit("a", "create", null, "{\"k\":1}"));
      tx.appendAudit(audit("b", "create", null, "{\"k\":2}"));
      tx.appendAudit(audit("a", "delete", "{\"k\":1}", null));
    });
    var all = repo.listAudit(null, 10, 0);
    assertEquals(3, all.total());
    assertEquals(List.of("a:delete", "b:create", "a:create"),
        all.items().stream().map(x -> x.flagKey() + ":" + x.action()).toList());
    assertEquals("{\"k\":1}", all.items().get(0).before());
    assertNull(all.items().get(0).after());
    assertNull(all.items().get(2).before());
    assertTrue(all.items().get(0).id() > all.items().get(1).id() && all.items().get(1).id() > all.items().get(2).id());
    var onlyA = repo.listAudit("a", 10, 0);
    assertEquals(2, onlyA.total());
    assertEquals(List.of("delete", "create"), onlyA.items().stream().map(AuditLog::action).toList());
    var page = repo.listAudit(null, 1, 1);
    assertEquals(3, page.total());
    assertEquals("b", page.items().get(0).flagKey());
    assertEquals(0, repo.listAudit("", 10, 0).total()); // an empty filter is a filter, not "no filter"
  }

  private static Event exposure(String user, String variant) {
    return new Event(Event.EXPOSURE, user, "f", variant, "");
  }

  private static Event conversion(String user, String goal) {
    return new Event(Event.CONVERSION, user, "", "", goal);
  }

  @Test
  void firstExposureWinsAndDuplicatesCountOnce() {
    repo.recordEvents(List.of(exposure("u1", "a"), exposure("u1", "b"), exposure("u1", "a"), exposure("u2", "b")));
    assertEquals(Map.of("a", 1, "b", 1), repo.variantCounts("f", "buy").exposures());
  }

  @Test
  void conversionsCountOncePerUserAndOnlyForExposedUsers() {
    repo.recordEvents(List.of(exposure("u1", "a"), exposure("u2", "a"), exposure("u3", "b")));
    repo.recordEvents(List.of(conversion("u1", "buy"), conversion("u1", "buy"), conversion("u3", "buy"),
        conversion("stranger", "buy"), conversion("u2", "other")));
    var counts = repo.variantCounts("f", "buy");
    assertEquals(Map.of("a", 2, "b", 1), counts.exposures());
    assertEquals(Map.of("a", 1, "b", 1), counts.conversions());
  }

  @Test
  void recordEventsIsAllOrNothing() {
    assertThrows(IllegalArgumentException.class,
        () -> repo.recordEvents(List.of(exposure("u1", "a"), new Event("click", "u1", "", "", ""))));
    assertEquals(Map.of(), repo.variantCounts("f", "buy").exposures());
  }

  @Test
  void dataSurvivesReopeningAFileDatabase(@TempDir Path dir) {
    String path = dir.resolve("flags.db").toString();
    SqliteRepository first = new SqliteRepository(path);
    put(first, new Flag("f", "kept", false, List.of(), 100, List.of(), T0, T0));
    first.close();
    SqliteRepository second = new SqliteRepository(path);
    assertEquals("kept", second.getFlag("f").description());
    second.close();
  }

  @Test
  void databasePathsWithSpecialCharactersWork(@TempDir Path dir) throws IOException {
    // No non-ASCII name here: a JVM started in the POSIX locale cannot even build such a Path
    // (sun.jnu.encoding is ANSI_X3.4-1968). That is a property of the environment, not of the service.
    for (String name : List.of("a b#c.db", "50%.db", "q?x.db", "a&b=c;d.db")) {
      SqliteRepository r = new SqliteRepository(dir.resolve(name).toString());
      put(r, make("f"));
      r.close();
      assertTrue(Files.exists(dir.resolve(name)), name);
    }
  }

  @Test
  void walModeIsOnForAFileDatabase(@TempDir Path dir) throws Exception {
    Path file = dir.resolve("wal.db");
    new SqliteRepository(file.toString()).close();
    try (Connection c = DriverManager.getConnection("jdbc:sqlite:" + file);
         ResultSet rs = c.createStatement().executeQuery("PRAGMA journal_mode")) {
      rs.next();
      assertEquals("wal", rs.getString(1));
    }
  }

  @Test
  void concurrentWritersDoNotCorruptState() throws Exception {
    int threads = 8;
    int perThread = 25;
    ExecutorService pool = Executors.newFixedThreadPool(threads);
    List<Future<?>> done = new ArrayList<>();
    for (int t = 0; t < threads; t++) {
      int id = t;
      done.add(pool.submit(() -> {
        for (int i = 0; i < perThread; i++) {
          String key = "t" + id + "-" + i;
          repo.inTransaction(tx -> {
            tx.insertFlag(make(key));
            tx.appendAudit(audit(key, "create", null, "{}"));
          });
          repo.listFlags(5, 0);
        }
      }));
    }
    for (Future<?> f : done) {
      f.get();
    }
    pool.shutdown();
    assertEquals(threads * perThread, repo.listFlags(1, 0).total());
    assertEquals(threads * perThread, repo.listAudit(null, 1, 0).total());
  }
}

package ffservice;

import com.fasterxml.jackson.core.JsonProcessingException;
import ffservice.model.Json;
import ffservice.repository.SqliteRepository;
import ffservice.service.FlagService;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.function.Supplier;

/** Helpers shared by the tests. */
public final class TestSupport {
  private static final Path VECTORS = Path.of("..", "tests", "vectors");

  private TestSupport() {
  }

  /** A shared vector file, decoded the way the service decodes request bodies. */
  @SuppressWarnings("unchecked")
  public static Map<String, Object> vectors(String name) {
    try {
      return (Map<String, Object>) Json.parse(Files.readString(VECTORS.resolve(name)));
    } catch (IOException e) {
      throw new IllegalStateException("cannot read vector file " + name, e);
    }
  }

  @SuppressWarnings("unchecked")
  public static List<Map<String, Object>> cases(String name) {
    return (List<Map<String, Object>>) vectors(name).get("cases");
  }

  public static Object json(String text) {
    try {
      return Json.parse(text);
    } catch (JsonProcessingException e) {
      throw new IllegalArgumentException("bad test JSON " + text, e);
    }
  }

  /** A clock that hands out a later time (one second) on every call, from 2026-01-31T08:00:01Z. */
  public static Supplier<Instant> clock() {
    Instant[] t = {Instant.parse("2026-01-31T08:00:00Z")};
    return () -> {
      t[0] = t[0].plusSeconds(1);
      return t[0];
    };
  }

  public static FlagService service(SqliteRepository repo) {
    return new FlagService(repo, clock());
  }
}

package ffservice;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

class ConfigTest {
  @Test
  void defaults() {
    assertEquals(new Config(8080, "./flags.db", "a", "c"), Config.load(Map.of("ADMIN_KEY", "a", "CLIENT_KEY", "c")));
  }

  @Test
  void valuesAreRead() {
    assertEquals(new Config(9000, "/tmp/x.db", "a", "c"),
        Config.load(Map.of("ADMIN_KEY", "a", "CLIENT_KEY", "c", "PORT", "9000", "DB_PATH", "/tmp/x.db")));
  }

  @Test
  void bothKeysAreRequired() {
    for (Map<String, String> env : java.util.List.of(Map.<String, String>of(), Map.of("ADMIN_KEY", "a"),
        Map.of("CLIENT_KEY", "c"), Map.of("ADMIN_KEY", "", "CLIENT_KEY", "c"))) {
      var e = assertThrows(IllegalArgumentException.class, () -> Config.load(env));
      assertTrue(e.getMessage().contains("KEY"), e.getMessage());
    }
  }

  @ParameterizedTest
  @ValueSource(strings = {"0", "65536", "-1", "abc", "8080x", "٨٠", "1.5", "123456", " 80"})
  void portMustBeANumberFrom1To65535(String port) {
    var e = assertThrows(IllegalArgumentException.class,
        () -> Config.load(Map.of("ADMIN_KEY", "a", "CLIENT_KEY", "c", "PORT", port)));
    assertTrue(e.getMessage().contains("PORT"), e.getMessage());
  }

  @Test
  void corsOriginsAreSplitTrimmedAndEmptyItemsDropped() {
    Map<String, String> base = Map.of("ADMIN_KEY", "a", "CLIENT_KEY", "c");
    assertEquals(java.util.List.of(), load(base, ""));
    assertEquals(java.util.List.of(), load(base, " , "));
    assertEquals(java.util.List.of("https://a.example", "https://b.example"),
        load(base, " https://a.example , https://b.example,"));
    assertEquals(java.util.List.of("*"), load(base, "*"));
  }

  private static java.util.List<String> load(Map<String, String> base, String origins) {
    var env = new java.util.HashMap<>(base);
    env.put("CORS_ORIGINS", origins);
    return Config.load(env).corsOrigins();
  }
}

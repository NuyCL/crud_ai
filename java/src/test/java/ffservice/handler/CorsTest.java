package ffservice.handler;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;

import ffservice.Application;
import ffservice.Config;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.boot.web.servlet.context.ServletWebServerApplicationContext;
import org.springframework.context.ConfigurableApplicationContext;

/** BR-56: CORS for the browser SDK, through a real server like {@link ApiTest}. */
class CorsTest {
  private static final String APP = "https://app.example.com";
  private static final String ALLOW = "access-control-allow-origin";
  private static ConfigurableApplicationContext listContext;
  private static ConfigurableApplicationContext starContext;
  private static ConfigurableApplicationContext offContext;
  private static int listPort;
  private static int starPort;
  private static int offPort;

  @BeforeAll
  static void start() {
    listContext = Application.start(new Config(0, ":memory:", "test-admin-key", "test-client-key", List.of(APP)));
    starContext = Application.start(new Config(0, ":memory:", "test-admin-key", "test-client-key", List.of("*")));
    offContext = Application.start(new Config(0, ":memory:", "test-admin-key", "test-client-key"));
    listPort = portOf(listContext);
    starPort = portOf(starContext);
    offPort = portOf(offContext);
  }

  @AfterAll
  static void stop() {
    listContext.close();
    starContext.close();
    offContext.close();
  }

  private static int portOf(ConfigurableApplicationContext context) {
    return ((ServletWebServerApplicationContext) context).getWebServer().getPort();
  }

  private static ApiTest.Response call(int port, String method, String path, String origin, String body, String auth)
      throws IOException {
    Map<String, byte[]> extra = origin == null ? Map.of() : Map.of("Origin", origin.getBytes(StandardCharsets.ISO_8859_1));
    return ApiTest.sendTo(port, method, path, body.getBytes(StandardCharsets.UTF_8), auth, extra);
  }

  @Test
  void preflightFromAnAllowedOriginIs204WithoutAKey() throws IOException {
    for (String path : List.of("/v1/evaluate", "/v1/events")) {
      ApiTest.Response r = call(listPort, "OPTIONS", path, APP, "", "none");
      assertEquals(204, r.status(), path);
      assertEquals(0, r.body().length);
      assertEquals(APP, r.headers().get(ALLOW));
      assertEquals("POST", r.headers().get("access-control-allow-methods"));
      assertEquals("Content-Type, X-Client-Key", r.headers().get("access-control-allow-headers"));
      assertEquals("600", r.headers().get("access-control-max-age"));
      assertEquals("Origin", r.headers().get("vary"));
      assertFalse(r.headers().containsKey("access-control-allow-credentials"));
    }
  }

  @Test
  void everyOtherPreflightIsTheUsual404() throws IOException {
    String[][] cases = {
        {"/v1/evaluate", null}, {"/v1/evaluate", "https://evil.example.org"}, {"/v1/evaluate", "null"},
        {"/v1/evaluate", APP + "/"}, {"/v1/evaluate", "http://app.example.com"}, {"/v1/evaluate", APP.toUpperCase()},
        {"/v1/events", "https://evil.example.org"}, {"/v1/flags", APP}, {"/v1/flags/x", APP}, {"/healthz", APP},
        {"/nope", APP}, {"/v1/evaluate/", APP}};
    for (String[] c : cases) {
      ApiTest.Response r = call(listPort, "OPTIONS", c[0], c[1], "", "none");
      assertEquals(404, r.status(), c[0] + " " + c[1]);
      assertEquals("FLAG_NOT_FOUND", r.code());
      assertNull(r.headers().get(ALLOW), c[0] + " " + c[1]);
      assertNull(r.headers().get("access-control-allow-methods"));
    }
  }

  @Test
  void postResponsesCarryTheOriginInEveryStatus() throws IOException {
    String event = "{\"events\":[{\"type\":\"conversion\",\"userId\":\"u\",\"goal\":\"g\"}]}";
    Object[][] cases = {
        {"/v1/evaluate", "{\"flags\":[]}", "client", 200}, {"/v1/evaluate", "[]", "client", 400},
        {"/v1/evaluate", "{}", "none", 401}, {"/v1/events", event, "client", 202},
        {"/v1/events", "{\"events\":[]}", "client", 400}};
    for (Object[] c : cases) {
      ApiTest.Response r = call(listPort, "POST", (String) c[0], APP, (String) c[1], (String) c[2]);
      assertEquals(c[3], r.status(), c[0] + " " + c[1]);
      assertEquals(APP, r.headers().get(ALLOW));
      assertEquals("Origin", r.headers().get("vary"));
    }
  }

  @Test
  void noCorsHeadersWithoutAnAllowedOriginOrOnOtherPaths() throws IOException {
    assertNull(call(listPort, "POST", "/v1/evaluate", null, "{\"flags\":[]}", "client").headers().get(ALLOW));
    ApiTest.Response stranger = call(listPort, "POST", "/v1/evaluate", "https://evil.example.org", "{\"flags\":[]}", "client");
    assertEquals(200, stranger.status());
    assertNull(stranger.headers().get(ALLOW));
    for (String path : List.of("/healthz", "/v1/flags", "/v1/evaluate")) {
      assertNull(call(listPort, "GET", path, APP, "", "admin").headers().get(ALLOW), path);
    }
  }

  @Test
  void starAllowsEveryOriginAndSendsNoVary() throws IOException {
    ApiTest.Response r = call(starPort, "OPTIONS", "/v1/events", "https://anything.example", "", "none");
    assertEquals(204, r.status());
    assertEquals("*", r.headers().get(ALLOW));
    assertNull(r.headers().get("vary"));
    assertNull(call(starPort, "POST", "/v1/evaluate", null, "{\"flags\":[]}", "client").headers().get(ALLOW));
  }

  @Test
  void corsIsOffByDefault() throws IOException {
    assertEquals(404, call(offPort, "OPTIONS", "/v1/evaluate", APP, "", "none").status());
    assertNull(call(offPort, "POST", "/v1/evaluate", APP, "{\"flags\":[]}", "client").headers().get(ALLOW));
  }
}

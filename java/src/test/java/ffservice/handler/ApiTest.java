package ffservice.handler;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ffservice.Application;
import ffservice.Config;
import ffservice.TestSupport;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.boot.web.servlet.context.ServletWebServerApplicationContext;
import org.springframework.context.ConfigurableApplicationContext;

/**
 * The HTTP layer through a real server (Undertow on a free port) and a raw socket, so that the bytes on the wire are
 * exactly what each test says: an HTTP client library would refuse to send many of these requests.
 */
class ApiTest {
  private static final String ADMIN = "test-admin-key";
  private static final String CLIENT = "test-client-key";
  private static ConfigurableApplicationContext context;
  private static int port;

  @BeforeAll
  static void start() {
    context = Application.start(new Config(0, ":memory:", ADMIN, CLIENT));
    port = ((ServletWebServerApplicationContext) context).getWebServer().getPort();
  }

  @AfterAll
  static void stop() {
    context.close();
  }

  @BeforeEach
  void emptyTheDatabase() throws IOException {
    for (Object item : (List<?>) ((Map<?, ?>) send("GET", "/v1/flags?limit=100", "", "admin").json()).get("items")) {
      send("DELETE", "/v1/flags/" + ((Map<?, ?>) item).get("key"), "", "admin");
    }
  }

  // ------------------------------------------------------------------ client

  record Response(int status, Map<String, String> headers, byte[] body) {
    String text() {
      return new String(body, StandardCharsets.UTF_8);
    }

    Object json() {
      return TestSupport.json(text());
    }

    String code() {
      return (String) ((Map<?, ?>) ((Map<?, ?>) json()).get("error")).get("code");
    }
  }

  static Response send(String method, String target, String body, String auth) throws IOException {
    return send(method, target, body.getBytes(StandardCharsets.UTF_8), auth, Map.of());
  }

  static Response send(String method, String target, byte[] body, String auth, Map<String, byte[]> extra)
      throws IOException {
    return sendTo(port, method, target, body, auth, extra);
  }

  static Response sendTo(int serverPort, String method, String target, byte[] body, String auth,
      Map<String, byte[]> extra) throws IOException {
    Map<String, byte[]> headers = new LinkedHashMap<>();
    switch (auth) {
      case "admin" -> headers.put("X-Admin-Key", ADMIN.getBytes(StandardCharsets.ISO_8859_1));
      case "client" -> headers.put("X-Client-Key", CLIENT.getBytes(StandardCharsets.ISO_8859_1));
      case "bad" -> {
        headers.put("X-Admin-Key", "wrong".getBytes(StandardCharsets.ISO_8859_1));
        headers.put("X-Client-Key", "wrong".getBytes(StandardCharsets.ISO_8859_1));
      }
      default -> { }
    }
    headers.putAll(extra);
    headers.putIfAbsent("Content-Type", "application/json".getBytes(StandardCharsets.ISO_8859_1));
    try (Socket socket = new Socket("127.0.0.1", serverPort)) {
      socket.setSoTimeout(30_000);
      OutputStream out = socket.getOutputStream();
      ByteArrayOutputStream head = new ByteArrayOutputStream();
      head.write((method + " " + target + " HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n"
          + "Content-Length: " + body.length + "\r\n").getBytes(StandardCharsets.ISO_8859_1));
      for (Map.Entry<String, byte[]> h : headers.entrySet()) {
        head.write((h.getKey() + ": ").getBytes(StandardCharsets.ISO_8859_1));
        head.write(h.getValue());
        head.write("\r\n".getBytes(StandardCharsets.ISO_8859_1));
      }
      head.write("\r\n".getBytes(StandardCharsets.ISO_8859_1));
      out.write(head.toByteArray());
      out.write(body);
      out.flush();
      return read(socket.getInputStream());
    }
  }

  private static Response read(InputStream in) throws IOException {
    ByteArrayOutputStream all = new ByteArrayOutputStream();
    in.transferTo(all);
    byte[] bytes = all.toByteArray();
    int split = indexOf(bytes, "\r\n\r\n".getBytes(StandardCharsets.ISO_8859_1));
    String head = new String(bytes, 0, split, StandardCharsets.ISO_8859_1);
    String[] lines = head.split("\r\n");
    Map<String, String> headers = new LinkedHashMap<>();
    for (int i = 1; i < lines.length; i++) {
      int colon = lines[i].indexOf(':');
      headers.put(lines[i].substring(0, colon).toLowerCase(java.util.Locale.ROOT), lines[i].substring(colon + 1).trim());
    }
    byte[] body = java.util.Arrays.copyOfRange(bytes, split + 4, bytes.length);
    return new Response(Integer.parseInt(lines[0].split(" ")[1]), headers, body);
  }

  private static int indexOf(byte[] haystack, byte[] needle) {
    outer:
    for (int i = 0; i + needle.length <= haystack.length; i++) {
      for (int j = 0; j < needle.length; j++) {
        if (haystack[i + j] != needle[j]) {
          continue outer;
        }
      }
      return i;
    }
    throw new IllegalStateException("no end of headers in " + new String(haystack, StandardCharsets.ISO_8859_1));
  }

  private static void assertError(Response r, int status, String code) {
    assertEquals(status, r.status(), r.text());
    assertEquals(code, r.code());
    assertTrue(r.headers().get("content-type").startsWith("application/json"), r.headers().toString());
  }

  // -------------------------------------------------------------------- tests

  @Test
  void br13HealthzNeedsNoKey() throws IOException {
    Response r = send("GET", "/healthz", "", "none");
    assertEquals(200, r.status());
    assertEquals(Map.of("status", "ok"), r.json());
  }

  @Test
  void br10Br12AdminEndpointsAcceptOnlyTheAdminKey() throws IOException {
    for (String[] route : new String[][] {{"GET", "/v1/flags"}, {"POST", "/v1/flags"}, {"GET", "/v1/flags/x"},
        {"PUT", "/v1/flags/x"}, {"DELETE", "/v1/flags/x"}, {"GET", "/v1/flags/x/results?goal=g"},
        {"GET", "/v1/audit-logs"}}) {
      assertError(send(route[0], route[1], "{}", "none"), 401, "UNAUTHORIZED");
      assertError(send(route[0], route[1], "{}", "bad"), 401, "UNAUTHORIZED");
      assertError(send(route[0], route[1], "{}", "client"), 403, "FORBIDDEN");
    }
  }

  @Test
  void br11ClientEndpointsAcceptEitherKey() throws IOException {
    for (String[] route : new String[][] {{"/v1/evaluate", "{}"},
        {"/v1/events", "{\"events\":[{\"type\":\"conversion\",\"userId\":\"u\",\"goal\":\"g\"}]}"}}) {
      assertTrue(List.of(200, 202).contains(send("POST", route[0], route[1], "admin").status()));
      assertTrue(List.of(200, 202).contains(send("POST", route[0], route[1], "client").status()));
      assertEquals(401, send("POST", route[0], route[1], "none").status());
      assertEquals(401, send("POST", route[0], route[1], "bad").status());
    }
  }

  @Test
  void br51AuthIsCheckedBeforeTheBodyIsRead() throws IOException {
    assertEquals(401, send("POST", "/v1/flags", "not json", "none").status());
    assertEquals(403, send("POST", "/v1/flags", "not json", "client").status());
    assertEquals(400, send("POST", "/v1/flags", "not json", "admin").status());
  }

  @Test
  void nonAsciiKeyHeadersAreAWrongKeyNotACrash() throws IOException {
    for (byte[] value : List.of("caf\u00e9".getBytes(StandardCharsets.ISO_8859_1), new byte[] {(byte) 0xff, (byte) 0xfe},
        "a".repeat(5000).getBytes(StandardCharsets.ISO_8859_1))) {
      assertError(send("GET", "/v1/flags", new byte[0], "none", Map.of("X-Admin-Key", value)), 401, "UNAUTHORIZED");
    }
    Response r = send("GET", "/v1/flags", new byte[0], "admin", Map.of("X-Client-Key", new byte[] {(byte) 0xe9}));
    assertEquals(200, r.status());
  }

  @Test
  void statusCodesAndContentTypeOfTheHappyPath() throws IOException {
    Response created = send("POST", "/v1/flags", "{\"key\":\"happy\",\"enabled\":true}", "admin");
    assertEquals(201, created.status());
    assertTrue(created.headers().get("content-type").startsWith("application/json"));
    assertEquals("happy", ((Map<?, ?>) created.json()).get("key"));
    assertEquals(200, send("GET", "/v1/flags/happy", "", "admin").status());
    assertEquals(200, send("PUT", "/v1/flags/happy", "{\"key\":\"happy\"}", "admin").status());
    assertEquals(1, ((Map<?, ?>) send("GET", "/v1/flags", "", "admin").json()).get("total"));
    assertEquals(2, ((Map<?, ?>) send("GET", "/v1/audit-logs?flagKey=happy", "", "admin").json()).get("total"));
    Response evaluated = send("POST", "/v1/evaluate", "{\"flags\":[\"happy\"]}", "client");
    Map<?, ?> results = (Map<?, ?>) ((Map<?, ?>) evaluated.json()).get("results");
    assertEquals("DISABLED", ((Map<?, ?>) results.get("happy")).get("reason"));
    assertEquals(Map.of("accepted", 1), send("POST", "/v1/events",
        "{\"events\":[{\"type\":\"conversion\",\"userId\":\"u\",\"goal\":\"g\"}]}", "client").json());
    Response deleted = send("DELETE", "/v1/flags/happy", "", "admin");
    assertEquals(204, deleted.status());
    assertEquals(0, deleted.body().length);
    assertError(send("GET", "/v1/flags/happy", "", "admin"), 404, "FLAG_NOT_FOUND");
  }

  @ParameterizedTest
  @ValueSource(strings = {
      "", "   ", "{", "[", "{\"key\":\"x\"} {\"key\":\"y\"}", "{\"key\":\"x\"} x", "{\"key\":\"x\"},", "NaN",
      "{\"key\":\"x\",\"unknown\":NaN}", "{\"key\":\"x\",\"unknown\":Infinity}", "{\"key\":\"x\",\"unknown\":-Infinity}",
      "{\"key\":\"x\",\"rolloutPercent\":01}", "{\"key\":\"x\",\"rolloutPercent\":.5}", "{\"key\":\"x\",\"rolloutPercent\":1.}",
      "{\"key\":\"x\",\"rolloutPercent\":+1}", "{\"key\":\"x\",}", "{'key':'x'}", "{\"key\":\"x\"} // c", "{\"key\":\"a\nb\"}",
      "\ufeff{\"key\":\"x\"}", "{\"key\":\"x\"}\u0000"})
  void br52BodiesThatAreNotOneJsonValueAreValidationErrors(String body) throws IOException {
    assertError(send("POST", "/v1/flags", body, "admin"), 400, "VALIDATION_ERROR");
  }

  @Test
  void br52ANumberLongerThanAnyRealOneIsRejectedNotCrashed() throws IOException {
    assertError(send("POST", "/v1/flags", "{\"key\":\"x\",\"rolloutPercent\":1" + "0".repeat(5000) + "}", "admin"), 400,
        "VALIDATION_ERROR");
    assertError(send("POST", "/v1/flags", "{\"key\":\"x\",\"rolloutPercent\":1e999999999999}", "admin"), 400,
        "VALIDATION_ERROR");
  }

  @Test
  void br52DeepNestingIsA400NotACrash() throws IOException {
    for (String body : List.of("[".repeat(100_000), "{\"a\":".repeat(50_000),
        "{\"key\":\"deep\",\"description\":" + "[".repeat(20_000) + "]".repeat(20_000) + "}")) {
      assertError(send("POST", "/v1/flags", body, "admin"), 400, "VALIDATION_ERROR");
    }
    assertError(send("GET", "/v1/flags/deep", "", "admin"), 404, "FLAG_NOT_FOUND");
  }

  @Test
  void br52InvalidUtf8AndUtf16AreRejectedNotRepaired() throws IOException {
    byte[] prefix = "{\"key\":\"x\",\"description\":\"".getBytes(StandardCharsets.UTF_8);
    byte[] suffix = "\"}".getBytes(StandardCharsets.UTF_8);
    List<byte[]> bodies = List.of(
        concat(prefix, new byte[] {(byte) 0xff}, suffix), concat(prefix, new byte[] {(byte) 0xc3, 0x28}, suffix),
        concat(prefix, new byte[] {(byte) 0xed, (byte) 0xa0, (byte) 0x80}, suffix),
        concat(prefix, new byte[] {(byte) 0xc0, (byte) 0xaf}, suffix),
        "{\"key\":\"x\"}".getBytes(StandardCharsets.UTF_16), "{\"key\":\"x\"}".getBytes(StandardCharsets.UTF_16LE));
    for (byte[] body : bodies) {
      assertError(send("POST", "/v1/flags", body, "admin", Map.of()), 400, "VALIDATION_ERROR");
    }
    assertError(send("GET", "/v1/flags/x", "", "admin"), 404, "FLAG_NOT_FOUND");
  }

  private static byte[] concat(byte[]... parts) {
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    for (byte[] p : parts) {
      out.writeBytes(p);
    }
    return out.toByteArray();
  }

  @Test
  void br52DuplicateKeysLastWinsAndContentTypeIsIgnored() throws IOException {
    Response r = send("POST", "/v1/flags", "{\"key\":\"first\",\"key\":\"second\"}".getBytes(StandardCharsets.UTF_8),
        "admin", Map.of("Content-Type", "text/plain".getBytes(StandardCharsets.ISO_8859_1)));
    assertEquals(201, r.status());
    assertEquals("second", ((Map<?, ?>) r.json()).get("key"));
    assertEquals(201, send("POST", "/v1/flags", "{\"key\":\"third\"}".getBytes(StandardCharsets.UTF_8), "admin",
        Map.of("Content-Type", "application/x-www-form-urlencoded".getBytes(StandardCharsets.ISO_8859_1))).status());
    // a PUT sent as a form is the case Spring's FormContentFilter would swallow the body of
    assertEquals(200, send("PUT", "/v1/flags/third", "{\"key\":\"third\",\"enabled\":true}".getBytes(StandardCharsets.UTF_8),
        "admin", Map.of("Content-Type", "application/x-www-form-urlencoded".getBytes(StandardCharsets.ISO_8859_1))).status());
  }

  @Test
  void br52AnOversizedBodyIsRejectedNotCrashed() throws IOException {
    assertError(send("POST", "/v1/flags", "{\"key\":\"big\"}" + " ".repeat(Api.MAX_BODY_BYTES + 1), "admin"), 400,
        "VALIDATION_ERROR");
    assertEquals(201, send("POST", "/v1/flags", "{\"key\":\"fits\"}" + " ".repeat(Api.MAX_BODY_BYTES - 20), "admin").status());
  }

  @Test
  void br54LoneSurrogatesAreNeverAServerError() throws IOException {
    send("POST", "/v1/flags", "{\"key\":\"f\",\"enabled\":true,\"variants\":[{\"key\":\"a\",\"weight\":50},"
        + "{\"key\":\"b\",\"weight\":50}]}", "admin");
    Response replacement = send("POST", "/v1/evaluate", "{\"flags\":[\"f\"],\"context\":{\"userId\":\"\\ufffd\"}}", "client");
    assertEquals(200, replacement.status());
    for (String lone : List.of("\\ud800", "\\udc00", "\\ud83d")) {
      Response r = send("POST", "/v1/evaluate", "{\"flags\":[\"f\"],\"context\":{\"userId\":\"" + lone + "\"}}", "client");
      assertEquals(200, r.status());
      assertEquals(replacement.json(), r.json());
    }
    assertEquals(201, send("POST", "/v1/flags", "{\"key\":\"g\",\"description\":\"\\ud800\"}", "admin").status());
    assertEquals("\ufffd", ((Map<?, ?>) send("GET", "/v1/flags/g", "", "admin").json()).get("description"));
    assertEquals(200, send("GET", "/v1/flags?limit=100", "", "admin").status());
  }

  @ParameterizedTest
  @ValueSource(strings = {"%FF", "%C3%28", "%ED%A0%80", "%C0%AF", "%00", "%7F", "a%FFb", "%F0%9F%98"})
  void br55APathKeyThatIsNotUtf8IsJustNotFound(String key) throws IOException {
    assertError(send("GET", "/v1/flags/" + key, "", "admin"), 404, "FLAG_NOT_FOUND");
    assertError(send("DELETE", "/v1/flags/" + key, "", "admin"), 404, "FLAG_NOT_FOUND");
    assertError(send("GET", "/v1/flags/" + key + "/results?goal=g", "", "admin"), 404, "FLAG_NOT_FOUND");
  }

  @ParameterizedTest
  @ValueSource(strings = {"/v1/flags/%zz", "/v1/flags/a%", "/v1/flags/%4"})
  void aBrokenPercentEscapeIsA400NotA500(String target) throws IOException {
    assertError(send("GET", target, "", "admin"), 400, "VALIDATION_ERROR");
  }

  @Test
  void anEncodedSlashIsPartOfTheKeyNotAPathSeparator() throws IOException {
    assertEquals(401, send("GET", "/v1/flags/a%2Fb", "", "none").status());
    assertEquals(403, send("GET", "/v1/flags/a%2Fb", "", "client").status());
    assertError(send("GET", "/v1/flags/a%2fb", "", "admin"), 404, "FLAG_NOT_FOUND");
    assertError(send("DELETE", "/v1/flags/a%2Fb", "", "admin"), 404, "FLAG_NOT_FOUND");
    assertError(send("PUT", "/v1/flags/a%2Fb", "{\"key\":\"a/b\"}", "admin"), 400, "INVALID_KEY");
    assertError(send("PUT", "/v1/flags/a%2Fb", "{\"key\":\"ab\"}", "admin"), 400, "KEY_IMMUTABLE");
    assertError(send("GET", "/v1/flags/a/b", "", "admin"), 404, "FLAG_NOT_FOUND");
    assertError(send("GET", "/v1/flags/a%252Fb", "", "admin"), 404, "FLAG_NOT_FOUND");
  }

  @Test
  void aSemicolonInAPathKeyIsPartOfTheKeyNotAMatrixParameter() throws IOException {
    send("POST", "/v1/flags", "{\"key\":\"a\"}", "admin");
    assertError(send("GET", "/v1/flags/a;b", "", "admin"), 404, "FLAG_NOT_FOUND"); // not flag "a"
    assertEquals(200, send("GET", "/v1/flags/a", "", "admin").status());
  }

  @Test
  void br53UnknownRoutesAnswerWithAJsonErrorBodyAndNeedNoKey() throws IOException {
    for (String[] route : new String[][] {{"GET", "/nope"}, {"GET", "/v1"}, {"GET", "/v1/flags/"}, {"GET", "/v1/flags/a/b"},
        {"PATCH", "/v1/flags"}, {"POST", "/healthz"}, {"GET", "/docs"}, {"GET", "/openapi.json"}, {"GET", "/error"},
        {"OPTIONS", "/v1/flags"}, {"TRACE", "/v1/flags"}, {"GET", "/v1/evaluate"}, {"DELETE", "/v1/flags"},
        {"GET", "/actuator/health"}, {"GET", "/v1/flags/a/results/x"}}) {
      assertError(send(route[0], route[1], "", "none"), 404, "FLAG_NOT_FOUND");
    }
  }

  @Test
  void br50TheFirstValueOfARepeatedQueryParameterCounts() throws IOException {
    for (String key : List.of("a", "b", "c")) {
      send("POST", "/v1/flags", "{\"key\":\"" + key + "\"}", "admin");
    }
    assertEquals(1, ((List<?>) ((Map<?, ?>) send("GET", "/v1/flags?limit=1&limit=100", "", "admin").json()).get("items")).size());
    assertEquals(200, send("GET", "/v1/flags?limit=100&limit=abc", "", "admin").status());
    assertEquals(400, send("GET", "/v1/flags?limit=abc&limit=1", "", "admin").status());
    assertEquals(200, send("GET", "/v1/flags?limit=%zz", "", "admin").status()); // a pair with a bad escape is ignored
    assertEquals(3, ((Map<?, ?>) send("GET", "/v1/flags?limit=2&offset=1", "", "admin").json()).get("total"));
    assertEquals(2, ((List<?>) ((Map<?, ?>) send("GET", "/v1/flags?limit=2&offset=1", "", "admin").json()).get("items")).size());
    assertEquals(1, ((List<?>) ((Map<?, ?>) send("GET", "/v1/flags?limit=1;x=2&limit=1", "", "admin").json()).get("items")).size());
  }

  @Test
  void queryValuesArePercentDecodedAndAPlusIsASpace() throws IOException {
    send("POST", "/v1/flags", "{\"key\":\"q\",\"enabled\":true}", "admin");
    for (String[] pair : new String[][] {{"buy+now", "buy now"}, {"buy%20now", "buy now"}, {"a%2Bb", "a+b"},
        {"%E0%B8%81", "\u0e01"}, {"x%3Dy", "x=y"}}) {
      Map<?, ?> report = (Map<?, ?>) send("GET", "/v1/flags/q/results?goal=" + pair[0], "", "admin").json();
      assertEquals(pair[1], report.get("goal"), pair[0]);
    }
  }

  @Test
  void aMethodThatHasNoRouteForAPathIsNotFoundEvenWhenAnotherMethodHas() throws IOException {
    send("POST", "/v1/flags", "{\"key\":\"m\",\"description\":\"before\"}", "admin");
    assertError(send("PATCH", "/v1/flags/m", "{\"key\":\"m\",\"description\":\"after\"}", "admin"), 404,
        "FLAG_NOT_FOUND");
    assertError(send("POST", "/v1/flags/m", "{\"key\":\"m\"}", "admin"), 404, "FLAG_NOT_FOUND");
    assertError(send("PUT", "/v1/flags", "{\"key\":\"m\"}", "admin"), 404, "FLAG_NOT_FOUND");
    assertError(send("POST", "/v1/flags/m/results?goal=g", "", "admin"), 404, "FLAG_NOT_FOUND");
    assertEquals("before", ((Map<?, ?>) send("GET", "/v1/flags/m", "", "admin").json()).get("description"));
  }

  @Test
  void everyErrorCodeMapsToItsStatus() throws IOException {
    send("POST", "/v1/flags", "{\"key\":\"f\"}", "admin");
    assertError(send("POST", "/v1/flags", "{\"key\":\"f\"}", "admin"), 409, "FLAG_EXISTS");
    assertError(send("POST", "/v1/flags", "{\"key\":\"BAD\"}", "admin"), 400, "INVALID_KEY");
    assertError(send("PUT", "/v1/flags/f", "{\"key\":\"g\"}", "admin"), 400, "KEY_IMMUTABLE");
    assertError(send("POST", "/v1/flags", "{\"key\":\"x\",\"variants\":[{\"key\":\"a\",\"weight\":100}]}", "admin"), 400,
        "INVALID_VARIANTS");
    assertError(send("POST", "/v1/flags", "[]", "admin"), 400, "VALIDATION_ERROR");
    assertError(send("GET", "/v1/flags/ghost", "", "admin"), 404, "FLAG_NOT_FOUND");
    assertError(send("GET", "/v1/flags/f/results", "", "admin"), 400, "VALIDATION_ERROR");
    assertError(send("GET", "/v1/flags/f/results?goal=", "", "admin"), 400, "VALIDATION_ERROR");
  }

  @Test
  void anUnexpectedFailureIsAnOpaque500() throws Exception {
    ConfigurableApplicationContext broken = Application.start(new Config(0, ":memory:", ADMIN, CLIENT));
    try {
      int brokenPort = ((ServletWebServerApplicationContext) broken).getWebServer().getPort();
      broken.getBean(ffservice.repository.Repository.class).close(); // every later query fails
      Response r = sendTo(brokenPort, "GET", "/v1/flags", new byte[0], "admin", Map.of());
      assertError(r, 500, "INTERNAL_ERROR");
      String text = r.text().toLowerCase(java.util.Locale.ROOT);
      assertFalse(text.contains("sql") || text.contains("closed") || text.contains("exception"), text);
      assertEquals(200, sendTo(brokenPort, "GET", "/healthz", new byte[0], "none", Map.of()).status());
    } finally {
      broken.close();
    }
  }

  @Test
  void anErrorBodyHasACodeAndAMessageAndNothingElse() throws IOException {
    Response r = send("GET", "/v1/flags/ghost", "", "admin");
    Map<?, ?> error = (Map<?, ?>) ((Map<?, ?>) r.json()).get("error");
    assertEquals(java.util.Set.of("code", "message"), error.keySet());
    assertFalse(((String) error.get("message")).isEmpty());
  }
}

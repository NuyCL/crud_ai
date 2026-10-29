package ffservice.handler;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/** Percent-decoding of paths and query strings, done by hand because the container's decoding is not the spec's. */
final class Query {
  static final Pattern BROKEN_ESCAPE = Pattern.compile("%(?![0-9A-Fa-f]{2})");

  private Query() {
  }

  /**
   * Decode %XX escapes as UTF-8. Bytes that are not valid UTF-8 become U+FFFD: no flag has such a key, so a path
   * like /v1/flags/%FF is "not found", not an error (BR-55). The text must contain no broken escape.
   */
  static String decode(String raw, boolean plusIsSpace) {
    ByteArrayOutputStream out = new ByteArrayOutputStream(raw.length());
    for (int i = 0; i < raw.length(); i++) {
      char c = raw.charAt(i);
      if (c == '%') {
        out.write(Integer.parseInt(raw, i + 1, i + 3, 16));
        i += 2;
      } else if (c == '+' && plusIsSpace) {
        out.write(' ');
      } else if (c < 0x80) {
        out.write(c);
      } else {
        byte[] bytes = String.valueOf(c).getBytes(StandardCharsets.ISO_8859_1); // a raw byte of the request line
        out.write(bytes, 0, bytes.length);
      }
    }
    return out.toString(StandardCharsets.UTF_8); // malformed input is replaced, never thrown
  }

  /**
   * Split a query string like Go's net/url: '&' separates pairs, '+' is a space, a pair with a bad escape or a ';'
   * is dropped, and a repeated name keeps all its values in order (the first one counts, BR-50).
   */
  static Map<String, List<String>> parse(String raw) {
    Map<String, List<String>> out = new LinkedHashMap<>();
    if (raw == null) {
      return out;
    }
    for (String pair : raw.split("&")) {
      if (pair.isEmpty() || pair.indexOf(';') >= 0 || BROKEN_ESCAPE.matcher(pair).find()) {
        continue;
      }
      int eq = pair.indexOf('=');
      String name = decode(eq < 0 ? pair : pair.substring(0, eq), true);
      String value = eq < 0 ? "" : decode(pair.substring(eq + 1), true);
      out.computeIfAbsent(name, k -> new ArrayList<>()).add(value);
    }
    return out;
  }
}

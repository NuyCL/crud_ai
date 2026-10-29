package ffservice;

import java.util.List;
import java.util.Map;

/** Configuration from environment variables only (CONVENTIONS.md). */
public record Config(int port, String dbPath, String adminKey, String clientKey) {
  /** Read PORT (default 8080), DB_PATH (default ./flags.db), ADMIN_KEY and CLIENT_KEY (both required). */
  public static Config load(Map<String, String> env) {
    List<String> missing = List.of("ADMIN_KEY", "CLIENT_KEY").stream()
        .filter(name -> env.getOrDefault(name, "").isEmpty())
        .toList();
    if (!missing.isEmpty()) {
      throw new IllegalArgumentException("missing required environment variable(s): " + String.join(", ", missing));
    }
    String rawPort = env.getOrDefault("PORT", "");
    if (rawPort.isEmpty()) {
      rawPort = "8080";
    }
    // [0-9], not \d or Character.isDigit: Arabic-Indic and full-width digits are not a port number
    if (!rawPort.matches("[0-9]{1,5}") || Integer.parseInt(rawPort) < 1 || Integer.parseInt(rawPort) > 65535) {
      throw new IllegalArgumentException("PORT must be a number from 1 to 65535, got \"" + rawPort + "\"");
    }
    String dbPath = env.getOrDefault("DB_PATH", "");
    return new Config(Integer.parseInt(rawPort), dbPath.isEmpty() ? "./flags.db" : dbPath, env.get("ADMIN_KEY"),
        env.get("CLIENT_KEY"));
  }
}

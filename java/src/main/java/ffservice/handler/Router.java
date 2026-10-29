package ffservice.handler;

import java.util.Optional;

/**
 * Maps a method and a raw (still percent-encoded) path to an endpoint, like Go's ServeMux patterns. Spring MVC's own
 * mapping is not used: it decodes the path before matching (so /v1/flags/a%2Fb would no longer be one segment),
 * strips ";parameters" from segments, and answers unknown routes in its own error shape.
 */
final class Router {
  enum Endpoint {
    HEALTHZ, LIST_FLAGS, CREATE_FLAG, GET_FLAG, UPDATE_FLAG, DELETE_FLAG, RESULTS, LIST_AUDIT, EVALUATE, EVENTS
  }

  /** The endpoint and, for /v1/flags/{key}..., the decoded key. */
  record Match(Endpoint endpoint, String key) {
  }

  private Router() {
  }

  /** Empty when no route matches (the caller answers 404 FLAG_NOT_FOUND, BR-53). */
  static Optional<Match> match(String method, String rawPath) {
    switch (rawPath) {
      case "/healthz":
        return method.equals("GET") ? found(Endpoint.HEALTHZ) : Optional.empty();
      case "/v1/flags":
        return switch (method) {
          case "GET" -> found(Endpoint.LIST_FLAGS);
          case "POST" -> found(Endpoint.CREATE_FLAG);
          default -> Optional.empty();
        };
      case "/v1/audit-logs":
        return method.equals("GET") ? found(Endpoint.LIST_AUDIT) : Optional.empty();
      case "/v1/evaluate":
        return method.equals("POST") ? found(Endpoint.EVALUATE) : Optional.empty();
      case "/v1/events":
        return method.equals("POST") ? found(Endpoint.EVENTS) : Optional.empty();
      default:
        break;
    }
    String prefix = "/v1/flags/";
    if (!rawPath.startsWith(prefix)) {
      return Optional.empty();
    }
    String rest = rawPath.substring(prefix.length());
    int slash = rest.indexOf('/');
    String rawKey = slash < 0 ? rest : rest.substring(0, slash);
    if (rawKey.isEmpty() || (slash >= 0 && !rest.substring(slash).equals("/results"))) {
      return Optional.empty();
    }
    String key = Query.decode(rawKey, false);
    if (slash >= 0) {
      return method.equals("GET") ? Optional.of(new Match(Endpoint.RESULTS, key)) : Optional.empty();
    }
    return switch (method) {
      case "GET" -> Optional.of(new Match(Endpoint.GET_FLAG, key));
      case "PUT" -> Optional.of(new Match(Endpoint.UPDATE_FLAG, key));
      case "DELETE" -> Optional.of(new Match(Endpoint.DELETE_FLAG, key));
      default -> Optional.empty();
    };
  }

  private static Optional<Match> found(Endpoint endpoint) {
    return Optional.of(new Match(endpoint, null));
  }
}

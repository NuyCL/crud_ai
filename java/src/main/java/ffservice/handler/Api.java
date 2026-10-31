package ffservice.handler;

import com.fasterxml.jackson.core.JsonProcessingException;
import ffservice.model.AuditLog;
import ffservice.model.Flag;
import ffservice.model.Json;
import ffservice.service.ErrorCode;
import ffservice.service.FlagService;
import ffservice.service.Parse;
import ffservice.service.ServiceError;
import jakarta.servlet.Filter;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletRequest;
import jakarta.servlet.ServletResponse;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * HTTP: authentication, JSON in and out, and the mapping from service errors to status codes. It holds no business
 * rules.
 *
 * <p>This is a servlet filter that answers every request itself and never passes one on, so Spring MVC never sees a
 * request. Its controller layer cannot be made to follow the spec: it decodes the path before matching, strips ";x"
 * from segments, answers OPTIONS and TRACE on its own, and has error pages of its own. {@link Router} picks the
 * endpoint instead, the way Go's ServeMux does. See docs/porting/java-analysis.md for the experiments.
 */
public class Api implements Filter {
  static final int MAX_BODY_BYTES = 1 << 20;
  private static final Logger LOG = LoggerFactory.getLogger(Api.class);

  private final FlagService service;
  private final Auth auth;
  private final List<String> corsOrigins;

  public Api(FlagService service, ffservice.Config config) {
    this.service = service;
    this.auth = new Auth(config.adminKey(), config.clientKey());
    this.corsOrigins = config.corsOrigins();
  }

  @Override
  public void doFilter(ServletRequest request, ServletResponse response, FilterChain chain) throws IOException {
    handle((HttpServletRequest) request, (HttpServletResponse) response);
  }

  /** Answer one request, whatever its method and path. */
  void handle(HttpServletRequest request, HttpServletResponse response) throws IOException {
    try {
      if (Query.BROKEN_ESCAPE.matcher(request.getRequestURI()).find()) {
        // "%zz" is not a path at all. (A well-formed escape for bytes that are not UTF-8, "%FF", is not an error:
        // it is a key no flag has, BR-55.)
        throw ServiceError.validation("malformed request");
      }
      if (cors(request, response)) {
        return;
      }
      Optional<Router.Match> match = Router.match(request.getMethod(), request.getRequestURI());
      if (match.isEmpty()) {
        writeError(response, ErrorCode.FLAG_NOT_FOUND, "no such route"); // no key needed (BR-53)
        return;
      }
      dispatch(match.get(), request, response);
    } catch (ServiceError e) {
      writeError(response, e.code(), e.getMessage());
    } catch (Exception | StackOverflowError e) {
      // anything unexpected is an opaque 500; the details go to the log only
      LOG.error("internal error serving {} {}", request.getMethod(), request.getRequestURI(), e);
      if (!response.isCommitted()) {
        writeError(response, ErrorCode.INTERNAL_ERROR, "internal error");
      }
    }
  }

  /**
   * BR-56: CORS only for POST and OPTIONS on the two client endpoints, only for an allowed Origin. Sets the headers a
   * POST response needs and answers a preflight itself (true: done, no key needed). Everything else goes on untouched.
   */
  private boolean cors(HttpServletRequest request, HttpServletResponse response) {
    String origin = request.getHeader("Origin");
    String path = request.getRequestURI();
    String method = request.getMethod();
    if (origin == null || origin.isEmpty() || !(path.equals("/v1/evaluate") || path.equals("/v1/events"))
        || !(method.equals("POST") || method.equals("OPTIONS"))) {
      return false;
    }
    boolean star = corsOrigins.contains("*");
    if (!star && !corsOrigins.contains(origin)) {
      return false;
    }
    response.setHeader("Access-Control-Allow-Origin", star ? "*" : origin);
    if (!star) {
      response.setHeader("Vary", "Origin");
    }
    if (method.equals("POST")) {
      return false;
    }
    response.setHeader("Access-Control-Allow-Methods", "POST");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Client-Key");
    response.setHeader("Access-Control-Max-Age", "600");
    response.setStatus(204);
    return true;
  }

  private void dispatch(Router.Match match, HttpServletRequest request, HttpServletResponse response)
      throws IOException {
    Router.Endpoint endpoint = match.endpoint();
    if (endpoint == Router.Endpoint.HEALTHZ) {
      write(response, 200, Map.of("status", "ok"));
      return;
    }
    Auth.Level level = auth.of(request.getHeader("X-Admin-Key"), request.getHeader("X-Client-Key"));
    boolean adminOnly = endpoint != Router.Endpoint.EVALUATE && endpoint != Router.Endpoint.EVENTS;
    if (adminOnly) {
      if (level == Auth.Level.CLIENT) {
        throw new ServiceError(ErrorCode.FORBIDDEN, "this key cannot use the admin API");
      }
      if (level == Auth.Level.NONE) {
        throw new ServiceError(ErrorCode.UNAUTHORIZED, "missing or invalid admin key");
      }
    } else if (level == Auth.Level.NONE) {
      throw new ServiceError(ErrorCode.UNAUTHORIZED, "missing or invalid key");
    }

    switch (endpoint) {
      case LIST_FLAGS -> {
        Parse.Page page = Parse.page(Query.parse(request.getQueryString()));
        var result = service.listFlags(page.limit(), page.offset());
        List<Object> items = result.items().stream().map(f -> (Object) f.toJson()).toList();
        write(response, 200, Map.of("items", items, "total", result.total()));
      }
      case CREATE_FLAG -> write(response, 201, service.createFlag(readJson(request)).toJson());
      case GET_FLAG -> write(response, 200, service.getFlag(match.key()).toJson());
      case UPDATE_FLAG -> write(response, 200, service.updateFlag(match.key(), readJson(request)).toJson());
      case DELETE_FLAG -> {
        service.deleteFlag(match.key());
        response.setStatus(204);
      }
      case RESULTS -> {
        List<String> goals = Query.parse(request.getQueryString()).get("goal");
        write(response, 200, service.results(match.key(), goals == null ? "" : goals.get(0)).toJson());
      }
      case LIST_AUDIT -> {
        Map<String, List<String>> query = Query.parse(request.getQueryString());
        Parse.Page page = Parse.page(query);
        String flagKey = query.containsKey("flagKey") ? query.get("flagKey").get(0) : null;
        var result = service.listAudit(flagKey, page.limit(), page.offset());
        List<Object> items = result.items().stream().map(a -> (Object) auditJson(a)).toList();
        write(response, 200, Map.of("items", items, "total", result.total()));
      }
      case EVALUATE -> {
        Map<String, Object> results = new LinkedHashMap<>();
        for (var entry : service.evaluate(readJson(request)).entrySet()) {
          results.put(entry.getKey(), entry.getValue().toJson());
        }
        write(response, 200, Map.of("results", results));
      }
      case EVENTS -> write(response, 202, Map.of("accepted", service.recordEvents(readJson(request))));
      default -> throw new IllegalStateException("unrouted endpoint " + endpoint);
    }
  }

  private static Map<String, Object> auditJson(AuditLog a) {
    Map<String, Object> json = new LinkedHashMap<>();
    json.put("id", a.id());
    json.put("flagKey", a.flagKey());
    json.put("action", a.action());
    json.put("before", a.before() == null ? null : parseStored(a.before()));
    json.put("after", a.after() == null ? null : parseStored(a.after()));
    json.put("createdAt", Flag.formatTime(a.createdAt()));
    return json;
  }

  private static Object parseStored(String json) {
    try {
      return Json.parse(json);
    } catch (JsonProcessingException e) {
      throw new IllegalStateException("corrupt audit entry", e);
    }
  }

  // ------------------------------------------------------------------- body

  /**
   * Read the whole body (even an oversized one: answering while the client is still uploading resets the
   * connection) and parse it as one strict JSON value (BR-52).
   */
  static Object readJson(HttpServletRequest request) throws IOException {
    ByteArrayOutputStream chunks = new ByteArrayOutputStream();
    long size = 0;
    byte[] buffer = new byte[8192];
    try (InputStream in = request.getInputStream()) {
      for (int n = in.read(buffer); n >= 0; n = in.read(buffer)) {
        size += n;
        if (size <= MAX_BODY_BYTES) {
          chunks.write(buffer, 0, n);
        }
      }
    }
    if (size > MAX_BODY_BYTES) {
      throw ServiceError.validation("request body is larger than 1 MiB");
    }
    try {
      // Strict UTF-8 first: invalid bytes and CESU-8 surrogates are errors, UTF-16 is not JSON here. Jackson given
      // bytes would sniff the encoding and accept UTF-16 and UTF-32; a BOM stays and is rejected by the parser.
      String text = StandardCharsets.UTF_8.newDecoder()
          .onMalformedInput(CodingErrorAction.REPORT)
          .onUnmappableCharacter(CodingErrorAction.REPORT)
          .decode(ByteBuffer.wrap(chunks.toByteArray()))
          .toString();
      return Parse.clean(Json.parse(text));
    } catch (CharacterCodingException | JsonProcessingException | RuntimeException | StackOverflowError e) {
      throw ServiceError.validation("request body must be valid JSON");
    }
  }

  // ---------------------------------------------------------------- response

  static void write(HttpServletResponse response, int status, Object body) throws IOException {
    byte[] bytes = Json.write(body);
    response.setStatus(status);
    response.setContentType("application/json");
    response.setContentLength(bytes.length);
    response.getOutputStream().write(bytes);
  }

  static void writeError(HttpServletResponse response, ErrorCode code, String message) throws IOException {
    write(response, code.status(), Map.of("error", Map.of("code", code.name(), "message", message)));
  }
}

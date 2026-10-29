package ffservice.service;

import ffservice.model.Context;
import ffservice.model.Event;
import ffservice.model.Flag;
import ffservice.model.Rule;
import ffservice.model.Scalars;
import ffservice.model.Variant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Validation of request bodies and query strings (BR-xx in spec/business-rules.md).
 *
 * <p>The parsers take what {@code Json.parse} returns: Map, List, String, Boolean, null and numbers as Integer, Long,
 * BigInteger or BigDecimal. Every pattern is matched with {@code matches()} (the whole text, no {@code $} that would
 * also match before a final line break) and uses [0-9] (Java's {@code \d} is ASCII-only, but the intent is explicit).
 */
public final class Parse {
  static final String KEY_PATTERN = "[a-z0-9][a-z0-9_-]{0,63}";
  static final String VARIANT_KEY_PATTERN = "[a-z0-9][a-z0-9_-]{0,31}";
  private static final Pattern KEY = Pattern.compile(KEY_PATTERN);
  private static final Pattern VARIANT_KEY = Pattern.compile(VARIANT_KEY_PATTERN);
  private static final Pattern DIGITS = Pattern.compile("[0-9]+");
  private static final Pattern TIMESTAMP = Pattern.compile(
      "([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\\.[0-9]+)?(?:Z|[+-]([0-9]{2}):([0-9]{2}))");

  static final int MAX_DESCRIPTION_CODE_POINTS = 500;
  static final int MIN_VARIANTS = 2;
  static final int MAX_VARIANTS = 10;
  static final int MAX_EVENTS = 100;

  private Parse() {
  }

  /** A decoded JSON object, or null if value is anything else. Keys are always strings. */
  @SuppressWarnings("unchecked")
  private static Map<String, Object> object(Object value) {
    return value instanceof Map<?, ?> ? (Map<String, Object>) value : null;
  }

  private static List<?> array(Object value) {
    return value instanceof List<?> list ? list : null;
  }

  private static String nonEmptyString(Object value) {
    return value instanceof String s && !s.isEmpty() ? s : null;
  }

  /** Validate a create/replace body (BR-01, BR-04, BR-08, BR-30..35) and apply the defaults. */
  public static Flag flagInput(Object raw) {
    Map<String, Object> body = object(raw);
    if (body == null) {
      throw ServiceError.validation("body must be a JSON object");
    }
    if (!(body.get("key") instanceof String key)) {
      throw ServiceError.validation("key is required and must be a string");
    }
    if (!KEY.matcher(key).matches()) {
      throw new ServiceError(ErrorCode.INVALID_KEY, "key must match " + KEY_PATTERN);
    }

    String description = "";
    boolean enabled = false;
    int rolloutPercent = 100;
    List<Rule> rules = List.of();
    List<Variant> variants = List.of();

    if (body.containsKey("description")) {
      if (!(body.get("description") instanceof String text)) {
        throw ServiceError.validation("description must be a string");
      }
      // Unicode code points: not UTF-16 units, which is what String.length() counts (BR-04).
      if (text.codePointCount(0, text.length()) > MAX_DESCRIPTION_CODE_POINTS) {
        throw ServiceError.validation("description must be at most " + MAX_DESCRIPTION_CODE_POINTS + " characters");
      }
      description = text;
    }
    if (body.containsKey("enabled")) {
      if (!(body.get("enabled") instanceof Boolean flag)) {
        throw ServiceError.validation("enabled must be a boolean");
      }
      enabled = flag;
    }
    if (body.containsKey("rolloutPercent")) {
      Integer percent = Scalars.asInt(body.get("rolloutPercent"));
      if (percent == null || percent < 0 || percent > 100) {
        throw ServiceError.validation("rolloutPercent must be an integer from 0 to 100");
      }
      rolloutPercent = percent;
    }
    if (body.containsKey("rules")) {
      rules = rules(body.get("rules"));
    }
    if (body.containsKey("variants")) {
      variants = variants(body.get("variants"));
    }
    return new Flag(key, description, enabled, rules, rolloutPercent, variants, null, null);
  }

  private static List<Rule> rules(Object value) {
    List<?> items = array(value);
    if (items == null) {
      throw ServiceError.validation("rules must be an array");
    }
    List<Rule> rules = new ArrayList<>();
    for (int i = 0; i < items.size(); i++) {
      Map<String, Object> item = object(items.get(i));
      if (item == null) {
        throw ServiceError.validation("rules[" + i + "] must be an object");
      }
      String attribute = nonEmptyString(item.get("attribute"));
      if (attribute == null) {
        throw ServiceError.validation("rules[" + i + "].attribute must be a non-empty string");
      }
      String operator = item.get("operator") instanceof String s ? s : "";
      if (!Set.of("eq", "neq", "in", "not_in").contains(operator)) {
        throw ServiceError.validation("rules[" + i + "].operator must be one of eq, neq, in, not_in");
      }
      rules.add(new Rule(attribute, operator, ruleValue(i, operator, item.get("value"))));
    }
    return List.copyOf(rules);
  }

  private static Object ruleValue(int index, String operator, Object value) {
    if (operator.equals("in") || operator.equals("not_in")) {
      List<?> items = array(value);
      if (items == null || items.isEmpty()) {
        throw ServiceError.validation("rules[" + index + "].value: must be a non-empty array of scalars");
      }
      List<Object> scalars = new ArrayList<>();
      for (Object item : items) {
        Object scalar = Scalars.of(item);
        if (scalar == null) {
          throw ServiceError.validation("rules[" + index + "].value: must be a non-empty array of scalars");
        }
        scalars.add(scalar);
      }
      return List.copyOf(scalars);
    }
    Object scalar = Scalars.of(value);
    if (scalar == null) {
      throw ServiceError.validation("rules[" + index + "].value: must be a string, number or boolean");
    }
    return scalar;
  }

  private static List<Variant> variants(Object value) {
    List<?> items = array(value);
    if (items == null) {
      throw ServiceError.validation("variants must be an array");
    }
    if (items.isEmpty()) {
      return List.of();
    }
    if (items.size() < MIN_VARIANTS || items.size() > MAX_VARIANTS) {
      throw ServiceError.variants("a flag with variants needs " + MIN_VARIANTS + " to " + MAX_VARIANTS + " of them");
    }
    List<Variant> variants = new ArrayList<>(); // keeps the order the client sent
    Set<String> seen = new HashSet<>();
    int total = 0;
    for (int i = 0; i < items.size(); i++) {
      Map<String, Object> item = object(items.get(i));
      if (item == null) {
        throw ServiceError.variants("variants[" + i + "] must be an object");
      }
      if (!(item.get("key") instanceof String key) || !VARIANT_KEY.matcher(key).matches()) {
        throw ServiceError.variants("variants[" + i + "].key must match " + VARIANT_KEY_PATTERN);
      }
      if (!seen.add(key)) {
        throw ServiceError.variants("variant key \"" + key + "\" is used twice");
      }
      Integer weight = Scalars.asInt(item.get("weight"));
      if (weight == null || weight < 1 || weight > 100) {
        throw ServiceError.variants("variants[" + i + "].weight must be an integer from 1 to 100");
      }
      total += weight;
      variants.add(new Variant(key, weight));
    }
    if (total != 100) {
      throw ServiceError.variants("weights must add up to 100, got " + total);
    }
    return List.copyOf(variants);
  }

  /** A validated POST /v1/evaluate body. {@code flags} is null when every flag is to be evaluated (BR-23). */
  public record EvaluateRequest(List<String> flags, Context context) {
  }

  /** Validate an evaluate body (BR-20). */
  public static EvaluateRequest evaluateRequest(Object raw) {
    Map<String, Object> body = object(raw);
    if (body == null) {
      throw ServiceError.validation("body must be a JSON object");
    }
    List<String> flags = null;
    if (body.containsKey("flags")) {
      List<?> items = array(body.get("flags"));
      if (items == null || !items.stream().allMatch(String.class::isInstance)) {
        throw ServiceError.validation("flags must be an array of strings");
      }
      flags = items.stream().map(String.class::cast).toList();
    }
    Context context = Context.EMPTY;
    if (body.containsKey("context")) {
      Map<String, Object> ctx = object(body.get("context"));
      if (ctx == null) {
        throw ServiceError.validation("context must be an object");
      }
      String userId = "";
      Map<String, Object> attributes = new LinkedHashMap<>();
      if (ctx.containsKey("userId")) {
        if (!(ctx.get("userId") instanceof String id)) {
          throw ServiceError.validation("context.userId must be a string");
        }
        userId = id;
      }
      if (ctx.containsKey("attributes")) {
        Map<String, Object> attrs = object(ctx.get("attributes"));
        if (attrs == null) {
          throw ServiceError.validation("context.attributes must be an object");
        }
        for (Map.Entry<String, Object> entry : attrs.entrySet()) {
          Object scalar = Scalars.of(entry.getValue());
          if (scalar == null) {
            throw ServiceError.validation(
                "context.attributes." + entry.getKey() + " must be a string, number or boolean");
          }
          attributes.put(entry.getKey(), scalar);
        }
      }
      context = new Context(userId, attributes);
    }
    return new EvaluateRequest(flags, context);
  }

  /** Validate a POST /v1/events body (BR-43). Nothing is returned unless every event is valid. */
  public static List<Event> events(Object raw) {
    Map<String, Object> body = object(raw);
    if (body == null) {
      throw ServiceError.validation("body must be a JSON object");
    }
    List<?> items = array(body.get("events"));
    if (items == null || items.isEmpty() || items.size() > MAX_EVENTS) {
      throw ServiceError.validation("events must be an array of 1 to " + MAX_EVENTS + " events");
    }
    List<Event> events = new ArrayList<>();
    for (int i = 0; i < items.size(); i++) {
      Map<String, Object> item = object(items.get(i));
      if (item == null) {
        throw ServiceError.validation("events[" + i + "] must be an object");
      }
      String type = item.get("type") instanceof String s ? s : "";
      if (!type.equals(Event.EXPOSURE) && !type.equals(Event.CONVERSION)) {
        throw ServiceError.validation("events[" + i + "].type must be exposure or conversion");
      }
      String userId = nonEmptyString(item.get("userId"));
      if (userId == null) {
        throw ServiceError.validation("events[" + i + "].userId must be a non-empty string");
      }
      Event event;
      if (type.equals(Event.EXPOSURE)) {
        String flagKey = nonEmptyString(item.get("flagKey"));
        if (flagKey == null) {
          throw ServiceError.validation("events[" + i + "].flagKey is required for an exposure");
        }
        String variant = nonEmptyString(item.get("variant"));
        if (variant == null) {
          throw ServiceError.validation("events[" + i + "].variant is required for an exposure");
        }
        event = new Event(type, userId, flagKey, variant, "");
      } else {
        String goal = nonEmptyString(item.get("goal"));
        if (goal == null) {
          throw ServiceError.validation("events[" + i + "].goal is required for a conversion");
        }
        event = new Event(type, userId, "", "", goal);
      }
      if (item.containsKey("timestamp") && !(item.get("timestamp") instanceof String s && validTimestamp(s))) {
        throw ServiceError.validation("events[" + i + "].timestamp must be an RFC 3339 string");
      }
      events.add(event);
    }
    return List.copyOf(events);
  }

  private static int daysInMonth(int year, int month) {
    if (month == 2) {
      boolean leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
      return leap ? 29 : 28;
    }
    return switch (month) {
      case 4, 6, 9, 11 -> 30;
      default -> 31;
    };
  }

  /**
   * RFC 3339 date-time that also exists on the calendar (BR-43). The grammar is checked with a pattern, then the
   * ranges by hand: java.time parsers are more lenient than RFC 3339 in some forms and stricter in others.
   */
  public static boolean validTimestamp(String s) {
    Matcher m = TIMESTAMP.matcher(s);
    if (!m.matches()) {
      return false;
    }
    int year = Integer.parseInt(m.group(1));
    int month = Integer.parseInt(m.group(2));
    int day = Integer.parseInt(m.group(3));
    int hour = Integer.parseInt(m.group(4));
    int minute = Integer.parseInt(m.group(5));
    int second = Integer.parseInt(m.group(6));
    if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
      return false;
    }
    if (hour > 23 || minute > 59 || second > 59) {
      return false;
    }
    return m.group(7) == null || (Integer.parseInt(m.group(7)) <= 23 && Integer.parseInt(m.group(8)) <= 59);
  }

  /** Limit and offset of a page. */
  public record Page(int limit, int offset) {
  }

  /** Read limit and offset from a parsed query string (BR-50). The first value of a repeated name counts. */
  public static Page page(Map<String, List<String>> query) {
    return new Page(number(query, "limit", 20, 1, 100), number(query, "offset", 0, 0, Integer.MAX_VALUE));
  }

  private static int number(Map<String, List<String>> query, String name, int fallback, int low, int high) {
    List<String> values = query.get(name);
    if (values == null || values.isEmpty()) {
      return fallback;
    }
    String text = values.get(0);
    if (!DIGITS.matcher(text).matches()) {
      throw ServiceError.validation(name + " must be an integer");
    }
    long n = text.length() < 19 ? Long.parseLong(text) : Long.MAX_VALUE; // never convert a 4000-digit number
    if (n < low || n > high) {
      throw ServiceError.validation(name + " must be between " + low + " and " + high);
    }
    return (int) n;
  }

  /**
   * Replace each lone surrogate in a decoded JSON value with U+FFFD, in strings and in object keys (BR-54). Java
   * strings may hold them (Jackson accepts "\ud800"), but they cannot be encoded as UTF-8: String.getBytes turns
   * them into '?', which would change every hash. Go's decoder substitutes U+FFFD, so doing the same makes both
   * services answer alike.
   */
  public static Object clean(Object value) {
    if (value instanceof String s) {
      return cleanString(s);
    }
    if (value instanceof List<?> list) {
      List<Object> out = new ArrayList<>(list.size());
      for (Object item : list) {
        out.add(clean(item));
      }
      return out;
    }
    if (value instanceof Map<?, ?> map) {
      Map<String, Object> out = new LinkedHashMap<>();
      for (Map.Entry<?, ?> entry : map.entrySet()) {
        out.put(cleanString((String) entry.getKey()), clean(entry.getValue()));
      }
      return out;
    }
    return value;
  }

  static String cleanString(String s) {
    StringBuilder out = null;
    for (int i = 0; i < s.length(); i++) {
      char c = s.charAt(i);
      boolean lone;
      if (Character.isHighSurrogate(c) && i + 1 < s.length() && Character.isLowSurrogate(s.charAt(i + 1))) {
        if (out != null) {
          out.append(c).append(s.charAt(i + 1));
        }
        i++;
        continue;
      }
      lone = Character.isSurrogate(c);
      if (lone && out == null) {
        out = new StringBuilder(s.length()).append(s, 0, i);
      }
      if (out != null) {
        out.append(lone ? '�' : c);
      }
    }
    return out == null ? s : out.toString();
  }
}

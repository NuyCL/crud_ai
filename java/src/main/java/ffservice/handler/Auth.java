package ffservice.handler;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

/** The two API keys (BR-10..12). */
final class Auth {
  /** What a request is allowed to do. */
  enum Level { NONE, CLIENT, ADMIN }

  private final byte[] adminDigest;
  private final byte[] clientDigest;

  Auth(String adminKey, String clientKey) {
    if (adminKey.isEmpty() || clientKey.isEmpty()) {
      throw new IllegalArgumentException("both an admin key and a client key are required");
    }
    adminDigest = sha256(adminKey.getBytes(StandardCharsets.UTF_8));
    clientDigest = sha256(clientKey.getBytes(StandardCharsets.UTF_8));
  }

  /** The strongest key the request carries. A key header holds bytes, read here as Latin-1 text, so it is compared
   * as bytes and any value at all, however odd, is just a wrong key. */
  Level of(String adminHeader, String clientHeader) {
    if (matches(adminHeader, adminDigest)) {
      return Level.ADMIN;
    }
    return matches(clientHeader, clientDigest) ? Level.CLIENT : Level.NONE;
  }

  /** Comparing digests makes the comparison constant-time whatever the lengths. */
  private static boolean matches(String header, byte[] expectedDigest) {
    byte[] value = (header == null ? "" : header).getBytes(StandardCharsets.ISO_8859_1);
    return MessageDigest.isEqual(sha256(value), expectedDigest);
  }

  private static byte[] sha256(byte[] bytes) {
    try {
      return MessageDigest.getInstance("SHA-256").digest(bytes);
    } catch (NoSuchAlgorithmException e) {
      throw new IllegalStateException(e);
    }
  }
}

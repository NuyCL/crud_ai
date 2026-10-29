package ffservice.model;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import java.math.BigDecimal;
import java.math.BigInteger;
import org.junit.jupiter.api.Test;

class ScalarsTest {
  @Test
  void ofKeepsStringsAndBooleansAndTurnsEveryNumberIntoADouble() {
    assertEquals("a", Scalars.of("a"));
    assertEquals(true, Scalars.of(true));
    assertEquals(1.0, Scalars.of(1));
    assertEquals(1.0, Scalars.of(1L));
    assertEquals(1.0, Scalars.of(new BigInteger("1")));
    assertEquals(10.0, Scalars.of(new BigDecimal("1e1")));
    assertEquals(0.1, Scalars.of(new BigDecimal("0.1")));
    assertEquals(9007199254740992.0, Scalars.of(new BigInteger("9007199254740993")), "rounds to even like a double");
  }

  @Test
  void ofRejectsWhatIsNotAScalarOrDoesNotFitADouble() {
    assertNull(Scalars.of(null));
    assertNull(Scalars.of(java.util.List.of()));
    assertNull(Scalars.of(java.util.Map.of()));
    assertNull(Scalars.of(Double.POSITIVE_INFINITY));
    assertNull(Scalars.of(Double.NaN));
    assertNull(Scalars.of(new BigDecimal("1e999")));
    assertNull(Scalars.of(new BigInteger("9".repeat(400))));
    assertNull(Scalars.of(new BigDecimal("1e999999999"))); // must be decided without computing it
  }

  @Test
  void ofSendsTinyNumbersToZeroLikeGoDoes() {
    assertEquals(0.0, Scalars.of(new BigDecimal("1e-999")));
    assertEquals(0.0, Scalars.of(new BigDecimal("1e-999999999")));
    assertEquals(0.0, Scalars.of(BigDecimal.ZERO));
  }

  @Test
  void asIntAcceptsWholeNumbersWithinAThousandMillion() {
    assertEquals(10, Scalars.asInt(10));
    assertEquals(10, Scalars.asInt(10L));
    assertEquals(10, Scalars.asInt(new BigDecimal("10.0")));
    assertEquals(10, Scalars.asInt(new BigDecimal("1e1")));
    assertEquals(10, Scalars.asInt(10.0));
    assertEquals(0, Scalars.asInt(new BigDecimal("-0.0")));
    assertEquals(0, Scalars.asInt(new BigDecimal("0e-5")));
    assertEquals(-1_000_000_000, Scalars.asInt(-1_000_000_000L));
    assertEquals(1_000_000_000, Scalars.asInt(new BigDecimal("1e9")));
  }

  @Test
  void asIntRejectsFractionsBigNumbersAndNonNumbers() {
    assertNull(Scalars.asInt(new BigDecimal("10.5")));
    assertNull(Scalars.asInt(new BigDecimal("1e-1")));
    assertNull(Scalars.asInt(10.5));
    assertNull(Scalars.asInt(1_000_000_001L));
    assertNull(Scalars.asInt(new BigInteger("9".repeat(30))));
    assertNull(Scalars.asInt(new BigDecimal("1e999")));
    assertNull(Scalars.asInt(Double.NaN));
    assertNull(Scalars.asInt(Double.POSITIVE_INFINITY));
    assertNull(Scalars.asInt(true));
    assertNull(Scalars.asInt("10"));
    assertNull(Scalars.asInt(null));
  }
}

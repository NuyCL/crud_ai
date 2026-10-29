package ffservice.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class ErfcTest {
  @Test
  void theTextbookApproximationWouldNotPassTheVectors() {
    // Abramowitz and Stegun 7.1.26. If this stops failing the vectors are too loose to protect the p-value.
    double x = 1.0;
    double t = 1 / (1 + 0.3275911 * x);
    double approx = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t
        * Math.exp(-x * x);
    assertTrue(Math.abs(approx - Erfc.erfc(x)) > 1e-9, "approximation differs by " + Math.abs(approx - Erfc.erfc(x)));
  }

  @Test
  void isContinuousAcrossTheSwitchOfMethod() {
    assertTrue(Math.abs(Erfc.erfc(2 - 1e-12) - Erfc.erfc(2 + 1e-12)) < 1e-13);
  }

  @Test
  void edgeValues() {
    assertEquals(1.0, Erfc.erfc(0));
    assertEquals(0.0, Erfc.erfc(Double.POSITIVE_INFINITY));
    assertEquals(2.0, Erfc.erfc(Double.NEGATIVE_INFINITY), 1e-15);
    assertTrue(Double.isNaN(Erfc.erfc(Double.NaN)));
    assertEquals(2 - Erfc.erfc(0.7), Erfc.erfc(-0.7), 1e-15);
    assertEquals(0.0, Erfc.erfc(30), 1e-300);
  }
}

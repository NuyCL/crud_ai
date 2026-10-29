package ffservice.service;

/**
 * The complementary error function. The Java standard library has none (Go has math.Erfc) and BR-42's p-value is
 * erfc(|z| / sqrt 2). The usual textbook approximation (Abramowitz and Stegun 7.1.26) is only good to about 1.5e-7,
 * which would change the 7th digit of pValue and `significant` near 0.05, so this implementation is held to
 * tests/vectors/erfc.json instead (1e-12 absolute / 1e-9 relative).
 */
final class Erfc {
  private static final double SQRT_PI = Math.sqrt(Math.PI);

  /** Below this the Taylor series is accurate; from here up the continued fraction converges quickly. */
  private static final double SERIES_LIMIT = 2;

  private static final int FRACTION_DEPTH = 150;

  private Erfc() {
  }

  /** erf(x) by its Taylor series: 2/sqrt(pi) * sum of (-1)^n x^(2n+1) / (n! (2n+1)). */
  private static double erfSeries(double x) {
    double x2 = x * x;
    double power = x; // x^(2n+1) / n!
    double sum = x;
    for (int n = 1; n < 200; n++) {
      power *= x2 / n;
      double term = power / (2 * n + 1);
      sum += n % 2 == 0 ? term : -term;
      if (Math.abs(term) < 1e-17 * Math.abs(sum)) {
        break;
      }
    }
    return 2 / SQRT_PI * sum;
  }

  /**
   * erfc(x) for x >= SERIES_LIMIT by the continued fraction
   * exp(-x^2) / sqrt(pi) / (x + (1/2) / (x + (2/2) / (x + (3/2) / (x + ...)))), evaluated from the tail.
   */
  private static double erfcFraction(double x) {
    double tail = x;
    for (int k = FRACTION_DEPTH; k >= 1; k--) {
      tail = x + k / 2.0 / tail;
    }
    return Math.exp(-x * x) / (SQRT_PI * tail);
  }

  /** erfc(x) = 1 - erf(x). Defined for every real x; NaN for NaN. */
  static double erfc(double x) {
    if (Double.isNaN(x)) {
      return Double.NaN;
    }
    if (x < 0) {
      return 2 - erfc(-x);
    }
    if (x == Double.POSITIVE_INFINITY) {
      return 0;
    }
    return x < SERIES_LIMIT ? 1 - erfSeries(x) : erfcFraction(x);
  }
}

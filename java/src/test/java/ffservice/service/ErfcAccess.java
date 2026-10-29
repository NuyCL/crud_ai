package ffservice.service;

/** Test-only door to the package-private erfc, so that the vectors test can live next to the other vector tests. */
public final class ErfcAccess {
  private ErfcAccess() {
  }

  public static double erfc(double x) {
    return Erfc.erfc(x);
  }
}

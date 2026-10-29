package ffservice.repository;

import ffservice.model.AuditLog;
import ffservice.model.Event;
import ffservice.model.Flag;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;

/** Everything the service needs from storage. The service depends on this interface, not on SQLite. */
public interface Repository extends AutoCloseable {
  /** A page of results and the total number of rows. */
  record Page<T>(List<T> items, int total) {
  }

  /** Exposures and conversions per variant key. */
  record Counts(Map<String, Integer> exposures, Map<String, Integer> conversions) {
  }

  /** Run work in a transaction. If it throws anything, all it did is rolled back and the exception is rethrown. */
  void inTransaction(Consumer<Tx> work);

  /** @throws NotFoundException if there is no such flag */
  Flag getFlag(String key);

  /** One page ordered by key ascending, and the total count. */
  Page<Flag> listFlags(int limit, int offset);

  List<Flag> listAllFlags();

  /** One page, newest first. A null flagKey means every flag. */
  Page<AuditLog> listAudit(String flagKey, int limit, int offset);

  /** Store all events or none. The first exposure of a (flag, user) wins; a (goal, user) conversion counts once. */
  void recordEvents(List<Event> events);

  /** Per variant key: the number of exposed users, and how many of them converted on goal. */
  Counts variantCounts(String flagKey, String goal);

  @Override
  void close();
}

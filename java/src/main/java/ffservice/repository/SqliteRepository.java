package ffservice.repository;

import com.fasterxml.jackson.core.JsonProcessingException;
import ffservice.model.AuditLog;
import ffservice.model.Event;
import ffservice.model.Flag;
import ffservice.model.Json;
import ffservice.model.Rule;
import ffservice.model.Scalars;
import ffservice.model.Variant;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.Consumer;
import java.util.function.Supplier;
import org.sqlite.SQLiteConfig;

/**
 * SQLite through JDBC (sqlite-jdbc).
 *
 * <p>One connection serves the whole process and every operation, including a whole transaction, holds one lock, so
 * statements from different request threads never interleave (the Go version gets the same effect from a pool of
 * one connection). A statement that fails rolls its transaction back; any exception does, including an Error.
 */
public final class SqliteRepository implements Repository {
  private static final String[] SCHEMA = {
      """
      CREATE TABLE IF NOT EXISTS flags (
        key             TEXT PRIMARY KEY,
        description     TEXT NOT NULL,
        enabled         INTEGER NOT NULL,
        rules           TEXT NOT NULL,
        rollout_percent INTEGER NOT NULL,
        variants        TEXT NOT NULL,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      )""",
      """
      CREATE TABLE IF NOT EXISTS audit_logs (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        flag_key   TEXT NOT NULL,
        action     TEXT NOT NULL,
        before     TEXT,
        after      TEXT,
        created_at TEXT NOT NULL
      )""",
      "CREATE INDEX IF NOT EXISTS audit_logs_flag_key ON audit_logs (flag_key, id)",
      """
      CREATE TABLE IF NOT EXISTS exposures (
        flag_key TEXT NOT NULL,
        user_id  TEXT NOT NULL,
        variant  TEXT NOT NULL,
        PRIMARY KEY (flag_key, user_id)
      )""",
      """
      CREATE TABLE IF NOT EXISTS conversions (
        goal    TEXT NOT NULL,
        user_id TEXT NOT NULL,
        PRIMARY KEY (goal, user_id)
      )""",
  };

  private static final String FLAG_COLUMNS =
      "key, description, enabled, rules, rollout_percent, variants, created_at, updated_at";

  private final Connection conn;
  private final ReentrantLock lock = new ReentrantLock();

  /** Open (and create if needed) the database at path; ":memory:" gives a private in-memory database. */
  public SqliteRepository(String path) {
    try {
      SQLiteConfig config = new SQLiteConfig();
      config.setBusyTimeout(5000);
      config.setTransactionMode(SQLiteConfig.TransactionMode.IMMEDIATE);
      if (!path.equals(":memory:")) {
        config.setJournalMode(SQLiteConfig.JournalMode.WAL);
      }
      // sqlite-jdbc takes everything after "jdbc:sqlite:" as the file name: no URI escaping of #, ? or %.
      conn = DriverManager.getConnection("jdbc:sqlite:" + path, config.toProperties());
      try (Statement st = conn.createStatement()) {
        for (String ddl : SCHEMA) {
          st.execute(ddl);
        }
      }
    } catch (SQLException e) {
      throw new StorageException("cannot open database " + path, e);
    }
  }

  @Override
  public void close() {
    lock.lock();
    try {
      conn.close();
    } catch (SQLException e) {
      throw new StorageException("cannot close database", e);
    } finally {
      lock.unlock();
    }
  }

  private <T> T locked(Supplier<T> work) {
    lock.lock();
    try {
      return work.get();
    } finally {
      lock.unlock();
    }
  }

  // ------------------------------------------------------------ rows <-> model

  private static Flag flagFrom(ResultSet rs) throws SQLException {
    return new Flag(
        rs.getString("key"),
        rs.getString("description"),
        rs.getInt("enabled") != 0,
        rulesFrom(rs.getString("rules")),
        rs.getInt("rollout_percent"),
        variantsFrom(rs.getString("variants")),
        Flag.parseTime(rs.getString("created_at")),
        Flag.parseTime(rs.getString("updated_at")));
  }

  private static List<Rule> rulesFrom(String json) {
    List<Rule> rules = new ArrayList<>();
    for (Object item : (List<?>) parse(json)) {
      Map<?, ?> m = (Map<?, ?>) item;
      Object value = m.get("value");
      Object scalar = value instanceof List<?> list ? list.stream().map(Scalars::of).toList() : Scalars.of(value);
      rules.add(new Rule((String) m.get("attribute"), (String) m.get("operator"), scalar));
    }
    return List.copyOf(rules);
  }

  private static List<Variant> variantsFrom(String json) {
    List<Variant> variants = new ArrayList<>();
    for (Object item : (List<?>) parse(json)) {
      Map<?, ?> m = (Map<?, ?>) item;
      variants.add(new Variant((String) m.get("key"), Scalars.asInt(m.get("weight"))));
    }
    return List.copyOf(variants);
  }

  private static Object parse(String json) {
    try {
      return Json.parse(json);
    } catch (JsonProcessingException e) {
      throw new StorageException("corrupt JSON column: " + json, e);
    }
  }

  private static String rulesJson(Flag f) {
    return Json.stringify(f.rules().stream().map(Rule::toJson).toList());
  }

  private static String variantsJson(Flag f) {
    return Json.stringify(f.variants().stream().map(Variant::toJson).toList());
  }

  private static Flag queryFlag(Connection c, String key) throws SQLException {
    try (PreparedStatement ps = c.prepareStatement("SELECT " + FLAG_COLUMNS + " FROM flags WHERE key = ?")) {
      ps.setString(1, key);
      try (ResultSet rs = ps.executeQuery()) {
        if (!rs.next()) {
          throw new NotFoundException(key);
        }
        return flagFrom(rs);
      }
    }
  }

  // --------------------------------------------------------------- transaction

  private final class SqlTx implements Tx {
    @Override
    public Flag getFlag(String key) {
      try {
        return queryFlag(conn, key);
      } catch (SQLException e) {
        throw new StorageException("get flag " + key, e);
      }
    }

    @Override
    public void insertFlag(Flag f) {
      try {
        try (PreparedStatement ps = conn.prepareStatement("SELECT 1 FROM flags WHERE key = ?")) {
          ps.setString(1, f.key());
          try (ResultSet rs = ps.executeQuery()) {
            if (rs.next()) {
              throw new ExistsException(f.key());
            }
          }
        }
        try (PreparedStatement ps = conn.prepareStatement(
            "INSERT INTO flags (" + FLAG_COLUMNS + ") VALUES (?, ?, ?, ?, ?, ?, ?, ?)")) {
          ps.setString(1, f.key());
          ps.setString(2, f.description());
          ps.setInt(3, f.enabled() ? 1 : 0);
          ps.setString(4, rulesJson(f));
          ps.setInt(5, f.rolloutPercent());
          ps.setString(6, variantsJson(f));
          ps.setString(7, Flag.formatTime(f.createdAt()));
          ps.setString(8, Flag.formatTime(f.updatedAt()));
          ps.executeUpdate();
        }
      } catch (SQLException e) {
        throw new StorageException("insert flag " + f.key(), e);
      }
    }

    @Override
    public void updateFlag(Flag f) {
      try (PreparedStatement ps = conn.prepareStatement(
          "UPDATE flags SET description = ?, enabled = ?, rules = ?, rollout_percent = ?, variants = ?,"
              + " updated_at = ? WHERE key = ?")) {
        ps.setString(1, f.description());
        ps.setInt(2, f.enabled() ? 1 : 0);
        ps.setString(3, rulesJson(f));
        ps.setInt(4, f.rolloutPercent());
        ps.setString(5, variantsJson(f));
        ps.setString(6, Flag.formatTime(f.updatedAt()));
        ps.setString(7, f.key());
        if (ps.executeUpdate() == 0) {
          throw new NotFoundException(f.key());
        }
      } catch (SQLException e) {
        throw new StorageException("update flag " + f.key(), e);
      }
    }

    @Override
    public void deleteFlag(String key) {
      try (PreparedStatement ps = conn.prepareStatement("DELETE FROM flags WHERE key = ?")) {
        ps.setString(1, key);
        if (ps.executeUpdate() == 0) {
          throw new NotFoundException(key);
        }
      } catch (SQLException e) {
        throw new StorageException("delete flag " + key, e);
      }
    }

    @Override
    public void appendAudit(AuditLog a) {
      try (PreparedStatement ps = conn.prepareStatement(
          "INSERT INTO audit_logs (flag_key, action, before, after, created_at) VALUES (?, ?, ?, ?, ?)")) {
        ps.setString(1, a.flagKey());
        ps.setString(2, a.action());
        ps.setString(3, a.before()); // a null String is bound as SQL NULL
        ps.setString(4, a.after());
        ps.setString(5, Flag.formatTime(a.createdAt()));
        ps.executeUpdate();
      } catch (SQLException e) {
        throw new StorageException("append audit " + a.flagKey(), e);
      }
    }
  }

  @Override
  public void inTransaction(Consumer<Tx> work) {
    locked(() -> {
      try {
        conn.setAutoCommit(false);
        try {
          work.accept(new SqlTx());
          conn.commit();
        } catch (Throwable t) { // anything, Error included: the connection must not be left inside a transaction
          rollbackQuietly(t);
          throw t;
        } finally {
          conn.setAutoCommit(true);
        }
      } catch (SQLException e) {
        throw new StorageException("transaction", e);
      }
      return null;
    });
  }

  /** Roll back after a failure; if that fails too, the original failure is what the caller must see. */
  private void rollbackQuietly(Throwable original) {
    try {
      conn.rollback();
    } catch (SQLException e) {
      original.addSuppressed(e);
    }
  }

  // --------------------------------------------------------------------- reads

  @Override
  public Flag getFlag(String key) {
    return locked(() -> {
      try {
        return queryFlag(conn, key);
      } catch (SQLException e) {
        throw new StorageException("get flag " + key, e);
      }
    });
  }

  private static int count(Connection c, String sql, String... args) throws SQLException {
    try (PreparedStatement ps = c.prepareStatement(sql)) {
      for (int i = 0; i < args.length; i++) {
        ps.setString(i + 1, args[i]);
      }
      try (ResultSet rs = ps.executeQuery()) {
        rs.next();
        return rs.getInt(1);
      }
    }
  }

  @Override
  public Page<Flag> listFlags(int limit, int offset) {
    return locked(() -> {
      try {
        int total = count(conn, "SELECT COUNT(*) FROM flags");
        List<Flag> flags = new ArrayList<>();
        try (PreparedStatement ps = conn.prepareStatement(
            "SELECT " + FLAG_COLUMNS + " FROM flags ORDER BY key ASC LIMIT ? OFFSET ?")) {
          ps.setInt(1, limit);
          ps.setInt(2, offset);
          try (ResultSet rs = ps.executeQuery()) {
            while (rs.next()) {
              flags.add(flagFrom(rs));
            }
          }
        }
        return new Page<>(flags, total);
      } catch (SQLException e) {
        throw new StorageException("list flags", e);
      }
    });
  }

  @Override
  public List<Flag> listAllFlags() {
    return locked(() -> {
      try (Statement st = conn.createStatement();
           ResultSet rs = st.executeQuery("SELECT " + FLAG_COLUMNS + " FROM flags ORDER BY key ASC")) {
        List<Flag> flags = new ArrayList<>();
        while (rs.next()) {
          flags.add(flagFrom(rs));
        }
        return flags;
      } catch (SQLException e) {
        throw new StorageException("list all flags", e);
      }
    });
  }

  @Override
  public Page<AuditLog> listAudit(String flagKey, int limit, int offset) {
    return locked(() -> {
      String where = flagKey == null ? "" : " WHERE flag_key = ?";
      try {
        int total = flagKey == null
            ? count(conn, "SELECT COUNT(*) FROM audit_logs")
            : count(conn, "SELECT COUNT(*) FROM audit_logs" + where, flagKey);
        List<AuditLog> logs = new ArrayList<>();
        try (PreparedStatement ps = conn.prepareStatement(
            "SELECT id, flag_key, action, before, after, created_at FROM audit_logs" + where
                + " ORDER BY id DESC LIMIT ? OFFSET ?")) {
          int next = 1;
          if (flagKey != null) {
            ps.setString(next++, flagKey);
          }
          ps.setInt(next++, limit);
          ps.setInt(next, offset);
          try (ResultSet rs = ps.executeQuery()) {
            while (rs.next()) {
              logs.add(new AuditLog(
                  rs.getLong("id"), rs.getString("flag_key"), rs.getString("action"),
                  rs.getString("before"), rs.getString("after"), Flag.parseTime(rs.getString("created_at"))));
            }
          }
        }
        return new Page<>(logs, total);
      } catch (SQLException e) {
        throw new StorageException("list audit", e);
      }
    });
  }

  // -------------------------------------------------------------------- events

  @Override
  public void recordEvents(List<Event> events) {
    inTransaction(tx -> {
      try (PreparedStatement exposure = conn.prepareStatement(
          "INSERT OR IGNORE INTO exposures (flag_key, user_id, variant) VALUES (?, ?, ?)");
           PreparedStatement conversion = conn.prepareStatement(
               "INSERT OR IGNORE INTO conversions (goal, user_id) VALUES (?, ?)")) {
        for (Event e : events) {
          switch (e.type()) {
            case Event.EXPOSURE -> {
              exposure.setString(1, e.flagKey());
              exposure.setString(2, e.userId());
              exposure.setString(3, e.variant());
              exposure.executeUpdate();
            }
            case Event.CONVERSION -> {
              conversion.setString(1, e.goal());
              conversion.setString(2, e.userId());
              conversion.executeUpdate();
            }
            default -> throw new IllegalArgumentException("unknown event type \"" + e.type() + "\"");
          }
        }
      } catch (SQLException ex) {
        throw new StorageException("record events", ex);
      }
    });
  }

  @Override
  public Counts variantCounts(String flagKey, String goal) {
    return locked(() -> {
      try {
        Map<String, Integer> exposures = counts(
            "SELECT variant, COUNT(*) FROM exposures WHERE flag_key = ? GROUP BY variant", flagKey);
        Map<String, Integer> conversions = counts(
            "SELECT e.variant, COUNT(*) FROM exposures e"
                + " JOIN conversions c ON c.user_id = e.user_id AND c.goal = ?"
                + " WHERE e.flag_key = ? GROUP BY e.variant", goal, flagKey);
        return new Counts(exposures, conversions);
      } catch (SQLException e) {
        throw new StorageException("variant counts", e);
      }
    });
  }

  private Map<String, Integer> counts(String sql, String... args) throws SQLException {
    Map<String, Integer> out = new HashMap<>();
    try (PreparedStatement ps = conn.prepareStatement(sql)) {
      for (int i = 0; i < args.length; i++) {
        ps.setString(i + 1, args[i]);
      }
      try (ResultSet rs = ps.executeQuery()) {
        while (rs.next()) {
          out.put(rs.getString(1), rs.getInt(2));
        }
      }
    }
    return out;
  }
}

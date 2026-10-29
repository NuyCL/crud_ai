package ffservice.service;

import ffservice.evaluation.Evaluation;
import ffservice.model.AuditLog;
import ffservice.model.EvaluationResult;
import ffservice.model.Flag;
import ffservice.model.Json;
import ffservice.model.Results;
import ffservice.model.VariantResult;
import ffservice.repository.ExistsException;
import ffservice.repository.NotFoundException;
import ffservice.repository.Repository;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Supplier;

/**
 * The business rules (BR-xx in spec/business-rules.md) on top of the repository. It knows nothing about HTTP: failures
 * are {@link ServiceError}s carrying a machine-readable code, and the handler maps codes to status codes.
 */
public final class FlagService {
  /** The smallest number of exposures per variant for which a p-value is reported (BR-42). */
  static final int MIN_SAMPLE_FOR_SIGNIFICANCE = 30;

  private final Repository repo;
  private final Supplier<Instant> now;

  public FlagService(Repository repo) {
    this(repo, () -> Instant.now().truncatedTo(ChronoUnit.MILLIS));
  }

  /** For tests: a controllable clock. */
  public FlagService(Repository repo, Supplier<Instant> now) {
    this.repo = repo;
    this.now = now;
  }

  // ---------------------------------------------------------------- flags

  /** Validate raw (a decoded JSON body) and store a new flag with its audit entry (BR-01, BR-02, BR-07, BR-08). */
  public Flag createFlag(Object raw) {
    Flag parsed = Parse.flagInput(raw);
    Instant at = now.get();
    Flag flag = parsed.withTimes(at, at);
    try {
      repo.inTransaction(tx -> {
        tx.insertFlag(flag);
        tx.appendAudit(auditEntry(AuditLog.CREATE, flag.key(), null, flag, at));
      });
    } catch (ExistsException e) {
      throw new ServiceError(ErrorCode.FLAG_EXISTS, "flag \"" + flag.key() + "\" already exists");
    }
    return flag;
  }

  public Flag getFlag(String key) {
    try {
      return repo.getFlag(key);
    } catch (NotFoundException e) {
      throw notFound(key);
    }
  }

  public Repository.Page<Flag> listFlags(int limit, int offset) {
    return repo.listFlags(limit, offset);
  }

  /** Replace the flag at key (BR-03, BR-05, BR-09). Fields the body leaves out go back to their defaults. */
  public Flag updateFlag(String key, Object raw) {
    Flag parsed = Parse.flagInput(raw);
    if (!parsed.key().equals(key)) {
      throw new ServiceError(
          ErrorCode.KEY_IMMUTABLE, "key cannot be changed from \"" + key + "\" to \"" + parsed.key() + "\"");
    }
    Instant at = now.get();
    AtomicReference<Flag> stored = new AtomicReference<>();
    try {
      repo.inTransaction(tx -> {
        Flag old = tx.getFlag(key);
        Instant updatedAt = at.isBefore(old.updatedAt()) ? old.updatedAt() : at; // never goes backwards
        Flag flag = parsed.withTimes(old.createdAt(), updatedAt);
        tx.updateFlag(flag);
        tx.appendAudit(auditEntry(AuditLog.UPDATE, key, old, flag, at));
        stored.set(flag);
      });
    } catch (NotFoundException e) {
      throw notFound(key);
    }
    return stored.get();
  }

  /** Remove a flag and record it in the audit log (BR-06). */
  public void deleteFlag(String key) {
    Instant at = now.get();
    try {
      repo.inTransaction(tx -> {
        Flag old = tx.getFlag(key);
        tx.deleteFlag(key);
        tx.appendAudit(auditEntry(AuditLog.DELETE, key, old, null, at));
      });
    } catch (NotFoundException e) {
      throw notFound(key);
    }
  }

  public Repository.Page<AuditLog> listAudit(String flagKey, int limit, int offset) {
    return repo.listAudit(flagKey, limit, offset);
  }

  // ------------------------------------------------------------- evaluate

  /** Evaluate flags for the context in raw. Writes nothing (BR-22). */
  public Map<String, EvaluationResult> evaluate(Object raw) {
    Parse.EvaluateRequest req = Parse.evaluateRequest(raw);
    Map<String, EvaluationResult> results = new LinkedHashMap<>();
    if (req.flags() == null) {
      for (Flag flag : repo.listAllFlags()) {
        results.put(flag.key(), Evaluation.evaluate(flag, req.context()));
      }
      return results;
    }
    for (String key : req.flags()) {
      Flag flag;
      try {
        flag = repo.getFlag(key);
      } catch (NotFoundException e) {
        flag = null; // an unknown flag is a normal answer, not a failure (BR-21)
      }
      results.put(key, Evaluation.evaluate(flag, req.context()));
    }
    return results;
  }

  // --------------------------------------------------------------- events

  /** Validate and store a batch; returns how many events it contained (BR-43, BR-44). */
  public int recordEvents(Object raw) {
    var events = Parse.events(raw);
    repo.recordEvents(events);
    return events.size();
  }

  /** The experiment report of a flag for a goal (BR-42, BR-46). */
  public Results results(String flagKey, String goal) {
    if (goal.isEmpty()) {
      throw ServiceError.validation("goal is required");
    }
    Flag flag = getFlag(flagKey);
    Repository.Counts counts = repo.variantCounts(flagKey, goal);

    List<VariantResult> rows = new ArrayList<>();
    VariantResult control = null;
    for (var v : flag.variants()) {
      int exposures = counts.exposures().getOrDefault(v.key(), 0);
      int conversions = counts.conversions().getOrDefault(v.key(), 0);
      double rate = exposures > 0 ? (double) conversions / exposures : 0.0;
      if (control == null) {
        control = new VariantResult(v.key(), exposures, conversions, rate, null, false);
        rows.add(control);
        continue;
      }
      // Every variant is compared with the first one, the control.
      Double p = twoProportionPValue(control, exposures, conversions, rate);
      rows.add(new VariantResult(v.key(), exposures, conversions, rate, p, p != null && p < 0.05));
    }
    return new Results(flagKey, goal, rows);
  }

  /**
   * The pooled, two-sided two-proportion z-test of BR-42; null if a group is too small or the standard error is 0.
   */
  static Double twoProportionPValue(VariantResult control, int exposures, int conversions, double rate) {
    if (control.exposures() < MIN_SAMPLE_FOR_SIGNIFICANCE || exposures < MIN_SAMPLE_FOR_SIGNIFICANCE) {
      return null;
    }
    double n1 = control.exposures();
    double n2 = exposures;
    double pooled = (control.conversions() + conversions) / (n1 + n2);
    double se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
    if (se == 0) {
      return null;
    }
    double z = (rate - control.rate()) / se;
    return Erfc.erfc(Math.abs(z) / Math.sqrt(2));
  }

  private static ServiceError notFound(String key) {
    return new ServiceError(ErrorCode.FLAG_NOT_FOUND, "flag \"" + key + "\" not found");
  }

  /** Snapshot before and after as JSON, in the same shape the API returns for a flag. */
  private static AuditLog auditEntry(String action, String key, Flag before, Flag after, Instant at) {
    return new AuditLog(
        0, key, action, before == null ? null : Json.stringify(before.toJson()),
        after == null ? null : Json.stringify(after.toJson()), at);
  }
}

package ffservice.repository;

import ffservice.model.AuditLog;
import ffservice.model.Flag;

/** The operations that must commit or roll back together: a flag change and its audit entry. */
public interface Tx {
  /** @throws NotFoundException if there is no such flag */
  Flag getFlag(String key);

  /** @throws ExistsException if the key is taken */
  void insertFlag(Flag flag);

  /** @throws NotFoundException if there is no such flag */
  void updateFlag(Flag flag);

  /** @throws NotFoundException if there is no such flag */
  void deleteFlag(String key);

  void appendAudit(AuditLog entry);
}
